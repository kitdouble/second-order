// OAuth 2.1 authorization server so Claude and ChatGPT can connect to /mcp.
// The SDK router handles the protocol; this file supplies storage, consent and the bits it lacks:
// client ID metadata documents (CIMD), the `iss` response parameter, and a redirect allowlist.
import { Router } from 'express';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { db, hash, newId, newToken, now, DAY } from './db.js';
import { config } from './config.js';
import { requireUser } from './session.js';

const SCOPES = ['mcp'];
const REQUEST_TTL = 10 * 60 * 1000;
const CODE_TTL = 5 * 60 * 1000;
const CIMD_CACHE_TTL = DAY;

// Native clients (Zed, Claude Code) use loopback redirects, registered with or without a port (RFC 8252).
const isLoopback = (uri) => {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};
const isAllowedRedirect = (uri) =>
  isLoopback(uri) || config.redirectAllowlist.some((prefix) => String(uri).startsWith(prefix));

// Tokens are only good for this server's MCP endpoint (RFC 8707 audience).
function checkResource(resource) {
  if (!resource) return config.mcpUrl;
  const normalized = resource.href.replace(/\/$/, '');
  if (normalized !== config.mcpUrl) throw new InvalidTargetError(`Unknown resource ${resource.href}`);
  return config.mcpUrl;
}

/* ---------- Clients: dynamic registration + client ID metadata documents ---------- */

const saveClient = (info) =>
  db.prepare('INSERT OR REPLACE INTO oauth_clients (client_id, info, created_at) VALUES (?, ?, ?)')
    .run(info.client_id, JSON.stringify(info), now());

// A CIMD client_id is an HTTPS URL that serves the client's own metadata.
async function fetchMetadataDocument(clientId) {
  const url = new URL(clientId);
  if (url.protocol !== 'https:' || url.hostname === 'localhost' || /^[\d.]+$|:/.test(url.hostname)) return undefined;

  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } });
  const text = res.ok ? await res.text() : '';
  if (!text || text.length > 20_000) return undefined;
  const doc = JSON.parse(text);
  if (doc.client_id !== clientId) return undefined;
  if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.length || !doc.redirect_uris.every(isAllowedRedirect)) {
    return undefined;
  }
  return {
    client_id: clientId,
    client_name: doc.client_name,
    client_uri: doc.client_uri,
    logo_uri: doc.logo_uri,
    redirect_uris: doc.redirect_uris,
    grant_types: doc.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

const clientsStore = {
  async getClient(clientId) {
    const row = db.prepare('SELECT info, created_at FROM oauth_clients WHERE client_id = ?').get(clientId);
    const isCimd = clientId.startsWith('https://');
    if (row && (!isCimd || now() - row.created_at < CIMD_CACHE_TTL)) return JSON.parse(row.info);
    if (!isCimd) return undefined;
    try {
      const info = await fetchMetadataDocument(clientId);
      if (info) saveClient(info);
      return info;
    } catch {
      return undefined;
    }
  },

  registerClient(info) {
    if (!info.redirect_uris.every(isAllowedRedirect)) {
      throw new InvalidClientMetadataError('Second Order only accepts Claude, ChatGPT and Copilot Studio redirect URIs.');
    }
    saveClient(info);
    return info;
  },
};

/* ---------- Tokens ---------- */

function issueTokens({ clientId, userId, scopes, resource, grantId = newId() }) {
  const access = newToken();
  const refresh = newToken();
  const insert = db.prepare(
    `INSERT INTO oauth_tokens (token_hash, kind, grant_id, client_id, user_id, scopes, resource, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const accessTtl = config.accessTokenMinutes * 60 * 1000;
  insert.run(hash(access), 'access', grantId, clientId, userId, scopes, resource, now(), now() + accessTtl);
  insert.run(hash(refresh), 'refresh', grantId, clientId, userId, scopes, resource, now(), now() + config.refreshTokenDays * DAY);
  return { access_token: access, token_type: 'Bearer', expires_in: accessTtl / 1000, refresh_token: refresh, scope: scopes };
}

const provider = {
  clientsStore,

  // Park the request and send the browser to the consent page.
  async authorize(client, params, res) {
    const resource = checkResource(params.resource);
    const id = newToken();
    db.prepare(
      `INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null,
      SCOPES.join(' '), resource, now() + REQUEST_TTL);
    res.redirect(302, `/connect?request=${encodeURIComponent(id)}`);
  },

  async challengeForAuthorizationCode(client, code) {
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ? AND client_id = ? AND expires_at > ?')
      .get(hash(code), client.client_id, now());
    if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
    return row.code_challenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const row = db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(code));
    db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash(code)); // single use
    if (!row || row.client_id !== client.client_id || row.expires_at <= now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    if (resource && checkResource(resource) !== row.resource) throw new InvalidTargetError('resource mismatch');
    return issueTokens({ clientId: client.client_id, userId: row.user_id, scopes: row.scopes, resource: row.resource });
  },

  // Refresh tokens rotate: each one works once and is replaced by a new pair.
  async exchangeRefreshToken(client, refreshToken, _scopes, resource) {
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash(refreshToken));
    if (!row || row.client_id !== client.client_id || row.expires_at <= now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    if (resource && checkResource(resource) !== row.resource) throw new InvalidTargetError('resource mismatch');
    db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(row.grant_id);
    return issueTokens({ clientId: row.client_id, userId: row.user_id, scopes: row.scopes, resource: row.resource, grantId: row.grant_id });
  },

  async verifyAccessToken(token) {
    const row = db.prepare(
      `SELECT t.*, u.email, u.name, u.role FROM oauth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.kind = 'access' AND t.expires_at > ?`
    ).get(hash(token), now());
    if (!row || row.resource !== config.mcpUrl) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' '),
      expiresAt: Math.floor(row.expires_at / 1000),
      resource: new URL(row.resource),
      extra: { user: { id: row.user_id, email: row.email, name: row.name, role: row.role } },
    };
  },

  async revokeToken(client, { token }) {
    const row = db.prepare('SELECT grant_id, client_id FROM oauth_tokens WHERE token_hash = ?').get(hash(token));
    if (row?.client_id === client.client_id) db.prepare('DELETE FROM oauth_tokens WHERE grant_id = ?').run(row.grant_id);
  },
};

/* ---------- Wiring ---------- */

const issuerUrl = new URL(config.origin);
const resourceServerUrl = new URL(config.mcpUrl);
const metadata = createOAuthMetadata({ provider, issuerUrl, scopesSupported: SCOPES });
export const protectedResourceMetadataUrl = `${config.origin}/.well-known/oauth-protected-resource/mcp`;

export const oauthRouter = Router();

// Our metadata advertises the extras the SDK's default document doesn't.
oauthRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*').json({
    ...metadata,
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  });
});
// Some clients look for protected-resource metadata at the root as well as at /mcp.
oauthRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*').json({
    resource: config.mcpUrl,
    authorization_servers: [metadata.issuer],
    scopes_supported: SCOPES,
    resource_name: 'Second Order',
  });
});
oauthRouter.use(mcpAuthRouter({
  provider,
  issuerUrl,
  resourceServerUrl,
  scopesSupported: SCOPES,
  resourceName: 'Second Order',
  clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
}));

export const requireMcpAuth = requireBearerAuth({ verifier: provider, resourceMetadataUrl: protectedResourceMetadataUrl });

/* ---------- Consent page API (used by /connect in the browser) ---------- */

export const consent = Router();

function openRequest(id) {
  const request = db.prepare('SELECT * FROM oauth_requests WHERE id = ? AND expires_at > ?').get(String(id), now());
  return request ?? null;
}

function redirectWith(request, params) {
  const url = new URL(request.redirect_uri);
  for (const [k, v] of Object.entries({ ...params, state: request.state, iss: metadata.issuer })) {
    if (v != null) url.searchParams.set(k, v);
  }
  return url.href;
}

consent.get('/requests/:id', async (req, res) => {
  const request = openRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'This connection request has expired. Start again from Claude or ChatGPT.' });
  const client = await clientsStore.getClient(request.client_id);
  res.json({
    client: { name: client?.client_name || 'An app', redirectHost: new URL(request.redirect_uri).host },
    user: req.user,
  });
});

consent.post('/requests/:id/approve', requireUser, (req, res) => {
  const request = openRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'This connection request has expired. Start again from Claude or ChatGPT.' });
  const code = newToken();
  db.prepare(
    `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(hash(code), request.client_id, req.user.id, request.redirect_uri, request.code_challenge,
    request.scopes, request.resource, now() + CODE_TTL);
  db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(request.id);
  res.json({ redirect: redirectWith(request, { code }) });
});

consent.post('/requests/:id/deny', (req, res) => {
  const request = openRequest(req.params.id);
  if (!request) return res.status(404).json({ error: 'This connection request has expired.' });
  db.prepare('DELETE FROM oauth_requests WHERE id = ?').run(request.id);
  res.json({ redirect: redirectWith(request, { error: 'access_denied' }) });
});

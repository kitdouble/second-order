import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { pruneExpired } from './db.js';
import { loadUser, requireUser } from './session.js';
import { auth } from './auth.js';
import { consent, oauthRouter } from './oauth.js';
import { mcp } from './mcp.js';
import { runApp } from './run.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // behind Caddy on the VPS

/* ---------- Main origin: accounts, OAuth, MCP ---------- */

const main = express.Router();
main.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
main.use(express.json({ limit: '2mb' }));
main.use(express.urlencoded({ extended: false, limit: '100kb' })); // OAuth token requests are form-encoded
main.use(loadUser);

main.use('/api/auth', auth);
main.use('/api/oauth', consent);
main.use(oauthRouter); // /.well-known/*, /authorize, /token, /register, /revoke
main.use('/mcp', mcp);
main.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));
main.get('/api/health', (_req, res) => res.json({ ok: true }));
main.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production the API also serves the built front end.
const dist = resolve('dist');
if (config.production && existsSync(dist)) {
  main.use(express.static(dist, { index: false }));
  main.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

/* ---------- Dispatch by host ---------- */

const runHost = new URL(config.runOrigin).host;
app.use((req, res, next) => (req.get('host') === runHost ? runApp : main)(req, res, next));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status ?? 500).json({ error: err.status === 413 ? 'Request too large.' : 'Something went wrong.' });
});

pruneExpired();
setInterval(pruneExpired, 60 * 60 * 1000).unref();

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Second Order API on http://127.0.0.1:${config.port} (origin ${config.origin}, runs ${config.runOrigin}, rpID ${config.rpID})`);
});

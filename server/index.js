import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { pruneExpired } from './db.js';
import { loadUser, requireUser } from './session.js';
import { auth } from './auth.js';
import { consent, oauthRouter } from './oauth.js';
import { mcp } from './mcp.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // behind Caddy/nginx on the VPS

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' })); // OAuth token requests are form-encoded
app.use(loadUser);

app.use('/api/auth', auth);
app.use('/api/oauth', consent);
app.use(oauthRouter); // /.well-known/*, /authorize, /token, /register, /revoke
app.use('/mcp', mcp);
app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production the API also serves the built front end.
const dist = resolve('dist');
if (config.production && existsSync(dist)) {
  app.use(express.static(dist, { index: false }));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong.' });
});

pruneExpired();
setInterval(pruneExpired, 60 * 60 * 1000).unref();

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Second Order API on http://127.0.0.1:${config.port} (origin ${config.origin}, rpID ${config.rpID})`);
});

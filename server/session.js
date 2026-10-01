import { db, hash, newToken, now, DAY } from './db.js';
import { config } from './config.js';

const COOKIE = config.production ? '__Host-so_session' : 'so_session';

const cookieOpts = (maxAgeMs) => ({
  httpOnly: true,
  secure: config.production,
  sameSite: 'lax',
  path: '/',
  maxAge: maxAgeMs,
});

export function startSession(res, userId) {
  const token = newToken();
  const ttl = config.sessionDays * DAY;
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hash(token), userId, now(), now() + ttl);
  res.cookie(COOKIE, token, cookieOpts(ttl));
}

export function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
  res.clearCookie(COOKIE, cookieOpts(0));
}

// Attaches req.user (or null) to every request.
export function loadUser(req, _res, next) {
  const token = readCookie(req, COOKIE);
  req.user = token
    ? db.prepare(
        `SELECT u.id, u.email, u.name, u.role FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      ).get(hash(token), now()) ?? null
    : null;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

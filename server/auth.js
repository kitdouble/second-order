import { Router } from 'express';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { db, findOpenInvite, newId, newToken, now } from './db.js';
import { config } from './config.js';
import { endSession, readCookie, startSession } from './session.js';

const CHALLENGE_COOKIE = 'so_challenge';
const CHALLENGE_TTL = 5 * 60 * 1000;

export const auth = Router();

// Stash a WebAuthn challenge server-side; the browser only holds an opaque id.
function saveChallenge(res, { challenge, inviteHash = null, userId = null }) {
  const id = newToken();
  db.prepare('INSERT INTO challenges (id, challenge, invite_hash, user_id, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, challenge, inviteHash, userId, now() + CHALLENGE_TTL);
  res.cookie(CHALLENGE_COOKIE, id, {
    httpOnly: true, secure: config.production, sameSite: 'strict', path: '/api/auth', maxAge: CHALLENGE_TTL,
  });
}

// Single use: the challenge row is deleted as soon as it is read.
function takeChallenge(req, res) {
  const id = readCookie(req, CHALLENGE_COOKIE);
  res.clearCookie(CHALLENGE_COOKIE, { path: '/api/auth' });
  if (!id) return null;
  const row = db.prepare('SELECT * FROM challenges WHERE id = ? AND expires_at > ?').get(id, now());
  db.prepare('DELETE FROM challenges WHERE id = ?').run(id);
  return row ?? null;
}

const fail = (res, status, error) => res.status(status).json({ error });

/* ---------- Invites: look up, then register a passkey ---------- */

auth.get('/invite/:token', (req, res) => {
  const invite = findOpenInvite(req.params.token);
  if (!invite) return fail(res, 404, 'This invite link is invalid, used or expired.');
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(invite.email);
  res.json({ name: invite.name, email: invite.email, existingUser: Boolean(existing) });
});

auth.post('/invite/:token/options', async (req, res) => {
  const invite = findOpenInvite(req.params.token);
  if (!invite) return fail(res, 404, 'This invite link is invalid, used or expired.');

  // An invite for an existing email adds a passkey to that account (new device / recovery).
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);
  const userId = existing?.id ?? newId();
  const excludeCredentials = existing
    ? db.prepare('SELECT id, transports FROM credentials WHERE user_id = ?').all(userId)
        .map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined }))
    : [];

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userID: new TextEncoder().encode(userId),
    userName: invite.email,
    userDisplayName: existing?.name ?? invite.name,
    attestationType: 'none',
    excludeCredentials,
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });

  saveChallenge(res, { challenge: options.challenge, inviteHash: invite.token_hash, userId });
  res.json(options);
});

auth.post('/invite/:token/verify', async (req, res) => {
  const pending = takeChallenge(req, res);
  const invite = findOpenInvite(req.params.token);
  if (!invite) return fail(res, 404, 'This invite link is invalid, used or expired.');
  if (!pending || pending.invite_hash !== invite.token_hash) return fail(res, 400, 'Passkey setup timed out. Please try again.');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: false,
    });
  } catch (err) {
    return fail(res, 400, err.message);
  }
  if (!verification.verified) return fail(res, 400, 'Passkey could not be verified.');

  const { credential } = verification.registrationInfo;
  const userId = pending.user_id;

  db.exec('BEGIN');
  try {
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!existing) {
      db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, invite.email, invite.name, invite.role, now());
    }
    db.prepare(
      `INSERT INTO credentials (id, user_id, public_key, counter, transports, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(credential.id, userId, credential.publicKey, credential.counter,
      JSON.stringify(credential.transports ?? []), now());
    db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token_hash = ?').run(now(), userId, invite.token_hash);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  startSession(res, userId);
  res.json({ ok: true });
});

/* ---------- Sign in with an existing passkey ---------- */

auth.post('/login/options', async (_req, res) => {
  // No allowCredentials: the browser offers whichever discoverable passkey the user has for this site.
  const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'preferred' });
  saveChallenge(res, { challenge: options.challenge });
  res.json(options);
});

auth.post('/login/verify', async (req, res) => {
  const pending = takeChallenge(req, res);
  if (!pending || pending.invite_hash) return fail(res, 400, 'Sign-in timed out. Please try again.');

  const stored = db.prepare('SELECT * FROM credentials WHERE id = ?').get(String(req.body?.id));
  if (!stored) return fail(res, 401, "This passkey isn't registered with Second Order.");

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge: pending.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: new Uint8Array(stored.public_key),
        counter: stored.counter,
        transports: stored.transports ? JSON.parse(stored.transports) : undefined,
      },
    });
  } catch (err) {
    return fail(res, 401, err.message);
  }
  if (!verification.verified) return fail(res, 401, 'Passkey could not be verified.');

  db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, now(), stored.id);
  startSession(res, stored.user_id);
  res.json({ ok: true });
});

auth.post('/logout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});


// Passkeys (WebAuthn): sign in with Touch ID, Face ID, Windows Hello or a phone.
// A passkey belongs to the site's hostname, so one made on the web.app address
// won't work on 2ndorder.live and vice versa.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { q, one, j } from "./db.js";
import { createSession } from "./auth.js";
import { ServiceError } from "./studies.js";

const RP_NAME = "Second Order";
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64url"));

function site(base) {
  const u = new URL(base);
  return { rpID: u.hostname, origin: u.origin };
}

async function storeChallenge(challenge, userId = null) {
  await q("DELETE FROM webauthn_challenges WHERE expires_at < now()");
  const r = await one("INSERT INTO webauthn_challenges (challenge, user_id, expires_at) VALUES ($1,$2, now() + interval '5 minutes') RETURNING id", [
    challenge,
    userId,
  ]);
  return r.id;
}

async function takeChallenge(id, userId = null) {
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) throw new ServiceError("That sign-in attempt expired. Try again.");
  const c = await one("DELETE FROM webauthn_challenges WHERE id = $1 AND expires_at > now() RETURNING *", [id]);
  if (!c || (userId && c.user_id !== userId)) throw new ServiceError("That attempt expired. Try again.");
  return c.challenge;
}

export async function listPasskeys(userId) {
  return (await q("SELECT id, name, rp_id, created_at, last_used_at FROM passkeys WHERE user_id = $1 ORDER BY created_at", [userId])).rows;
}

// ---------------------------------------------------------------- adding

export async function registrationOptions(user, base) {
  const { rpID } = site(base);
  const existing = (await q("SELECT id, transports FROM passkeys WHERE user_id = $1 AND rp_id = $2", [user.id, rpID])).rows;
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userID: new TextEncoder().encode(user.id),
    userName: user.name,
    userDisplayName: user.name,
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ?? undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });
  return { challengeId: await storeChallenge(options.challenge, user.id), options };
}

function deviceName(ua = "") {
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Mac OS X/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "";
  return `${os}${browser ? ` · ${browser}` : ""}`;
}

export async function finishRegistration(user, base, { challengeId, response }, userAgent) {
  const { rpID, origin } = site(base);
  const expectedChallenge = await takeChallenge(challengeId, user.id);
  let v;
  try {
    v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID });
  } catch (e) {
    throw new ServiceError(`Couldn't add that passkey: ${e.message}`);
  }
  if (!v.verified || !v.registrationInfo) throw new ServiceError("Couldn't verify that passkey.");
  const { credential } = v.registrationInfo;
  await q(
    `INSERT INTO passkeys (id, user_id, public_key, counter, transports, rp_id, name) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO NOTHING`,
    [credential.id, user.id, b64(credential.publicKey), credential.counter ?? 0, j(credential.transports ?? null), rpID, deviceName(userAgent)],
  );
  await q("INSERT INTO audit_log (user_id, client, action, detail) VALUES ($1,'web','passkey_added',$2)", [user.id, j({ rp_id: rpID })]);
  return { ok: true };
}

export async function removePasskey(user, id) {
  const r = await q("DELETE FROM passkeys WHERE id = $1 AND user_id = $2", [id, user.id]);
  if (!r.rowCount) throw new ServiceError("No such passkey.");
  await q("INSERT INTO audit_log (user_id, client, action, detail) VALUES ($1,'web','passkey_removed','{}')", [user.id]);
}

// ---------------------------------------------------------------- signing in

export async function authenticationOptions(base) {
  const { rpID } = site(base);
  // No allowCredentials: the browser offers whichever passkeys it has for this site.
  const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
  return { challengeId: await storeChallenge(options.challenge), options };
}

/** Verifies a passkey sign-in and starts a session. */
export async function finishAuthentication(base, { challengeId, response }) {
  const { rpID, origin } = site(base);
  const expectedChallenge = await takeChallenge(challengeId);
  const cred = await one("SELECT * FROM passkeys WHERE id = $1 AND rp_id = $2", [response?.id, rpID]);
  if (!cred) throw new ServiceError("That passkey isn't registered here. Sign in with a link, then add a passkey in Settings.");
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: cred.id, publicKey: unb64(cred.public_key), counter: Number(cred.counter), transports: cred.transports ?? undefined },
    });
  } catch (e) {
    throw new ServiceError(`Passkey sign-in failed: ${e.message}`);
  }
  if (!v.verified) throw new ServiceError("Passkey sign-in failed.");
  await q("UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1", [cred.id, v.authenticationInfo.newCounter]);
  const session = await createSession(cred.user_id);
  if (!session) throw new ServiceError("This account is disabled.", 403);
  return session;
}

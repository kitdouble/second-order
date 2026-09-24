// Sign-in without email or passwords: the lab head issues one-time links, a
// link becomes a 30-day browser session, and people add passkeys so they can
// sign in again without a new link (passkeys.js). Agents sign in through OAuth
// (see oauth.js) and act as the person who approved them.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { q, one } from "./db.js";
import { newToken, sha256, safeEqual } from "./tokens.js";

// Firebase Hosting only forwards a cookie with exactly this name to Cloud Run.
export const COOKIE = "__session";
const SESSION_DAYS = 30;

export const TIERS = {
  lab_head: "Lab head",
  trusted: "Trusted",
  supervised: "Supervised",
};

export async function currentUser() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  return one(
    `SELECT u.* FROM web_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [sha256(token)],
  );
}

/** Actor object used by the service layer: who, and through which client. */
export async function webActor() {
  const user = await currentUser();
  return user ? { user, client: "web" } : null;
}

export async function requireActor() {
  const actor = await webActor();
  if (!actor) redirect("/");
  return actor;
}

export async function userCount() {
  return Number((await one("SELECT count(*) AS n FROM users")).n);
}

export async function createLoginLink(userId, createdBy, days = 7) {
  const token = newToken();
  await q("INSERT INTO login_links (token_hash, user_id, created_by, expires_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))", [
    sha256(token),
    userId,
    createdBy,
    days,
  ]);
  return token;
}

/** Turns a one-time link into a session token. Returns null if invalid. */
export async function consumeLoginLink(token) {
  const link = await one(
    `UPDATE login_links SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256(token)],
  );
  if (!link) return null;
  return createSession(link.user_id);
}

/** Starts a browser session for a user. Returns null if the user is disabled or missing. */
export async function createSession(userId) {
  const user = await one("SELECT * FROM users WHERE id = $1 AND NOT disabled", [userId]);
  if (!user) return null;
  const session = newToken(32);
  await q("INSERT INTO web_sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + make_interval(days => $3))", [
    sha256(session),
    user.id,
    SESSION_DAYS,
  ]);
  return { user, session, maxAge: SESSION_DAYS * 86400 };
}

export async function endSession(token) {
  if (token) await q("DELETE FROM web_sessions WHERE token_hash = $1", [sha256(token)]);
}

/** First-run: create the lab head, guarded by the BOOTSTRAP_TOKEN secret. */
export async function bootstrapLabHead(name, token) {
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected || !safeEqual(token ?? "", expected)) return { ok: false, error: "That setup code is not right." };
  if ((await userCount()) > 0) return { ok: false, error: "Setup has already been done." };
  const user = await one("INSERT INTO users (name, tier) VALUES ($1, 'lab_head') RETURNING *", [name]);
  const link = await createLoginLink(user.id, user.id, 1);
  return { ok: true, link };
}

/** Lab head recovery: the setup code signs in the first active lab head. */
export async function recoverLabHead(token) {
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected || !safeEqual(token ?? "", expected)) return { ok: false, error: "That setup code is not right." };
  const head = await one("SELECT id FROM users WHERE tier = 'lab_head' AND NOT disabled ORDER BY created_at LIMIT 1");
  if (!head) return { ok: false, error: "There is no active lab head account." };
  await q("INSERT INTO audit_log (user_id, client, action, detail) VALUES ($1, 'web', 'lab_head_recovery', '{}')", [head.id]);
  return { ok: true, session: await createSession(head.id) };
}

export function sessionCookie(session, base) {
  const secure = base.startsWith("https") ? "; Secure" : "";
  return `${COOKIE}=${session.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${session.maxAge}${secure}`;
}

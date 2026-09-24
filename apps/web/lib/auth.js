// Sign-in without email or passwords: the lab head issues one-time links,
// and a link becomes a 30-day browser session. Agents sign in through OAuth
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
  const user = await one("SELECT * FROM users WHERE id = $1 AND NOT disabled", [link.user_id]);
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

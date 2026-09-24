import { headers } from "next/headers";
import { currentUser, sessionCookie } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";
import { ServiceError } from "@/lib/studies";
import * as P from "@/lib/passkeys";

export const dynamic = "force-dynamic";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });

// Passkey endpoints: register-options/register-verify (signed in), login-options/login-verify.
export async function POST(req, { params }) {
  const { action } = await params;
  const h = await headers();
  const base = baseUrlFrom(h);
  // Same-origin only: a passkey ceremony from another site is refused.
  const origin = h.get("origin");
  if (origin && origin !== new URL(base).origin) return json({ error: "Wrong origin." }, 403);
  let body = {};
  try {
    body = await req.json();
  } catch {}
  try {
    if (action === "login-options") return json(await P.authenticationOptions(base));
    if (action === "login-verify") {
      const session = await P.finishAuthentication(base, body);
      return json({ ok: true, name: session.user.name }, 200, { "set-cookie": sessionCookie(session, base) });
    }
    const user = await currentUser();
    if (!user) return json({ error: "Sign in first." }, 401);
    if (action === "register-options") return json(await P.registrationOptions(user, base));
    if (action === "register-verify") return json(await P.finishRegistration(user, base, body, h.get("user-agent") ?? ""));
    return json({ error: "Not found." }, 404);
  } catch (e) {
    if (e instanceof ServiceError) return json({ error: e.message }, e.status ?? 400);
    console.error(e);
    return json({ error: "Something went wrong. It has been logged." }, 500);
  }
}

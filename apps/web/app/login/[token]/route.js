import { consumeLoginLink, COOKIE } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";

export const dynamic = "force-dynamic";

// Opening a sign-in link starts a 30-day session in this browser.
export async function GET(req, { params }) {
  const { token } = await params;
  const base = baseUrlFrom(req.headers);
  const r = await consumeLoginLink(token);
  if (!r) return Response.redirect(`${base}/?err=${encodeURIComponent("That sign-in link is used or expired. Ask the lab head for a new one.")}`, 303);
  const secure = base.startsWith("https") ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: `${base}/?msg=${encodeURIComponent(`Signed in as ${r.user.name}.`)}`,
      "set-cookie": `${COOKIE}=${r.session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${r.maxAge}${secure}`,
      "cache-control": "no-store",
    },
  });
}

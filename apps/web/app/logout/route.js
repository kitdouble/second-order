import { COOKIE, endSession } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const base = baseUrlFrom(req.headers);
  const token = req.cookies.get(COOKIE)?.value;
  await endSession(token);
  return new Response(null, {
    status: 303,
    headers: { location: `${base}/`, "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, "cache-control": "no-store" },
  });
}

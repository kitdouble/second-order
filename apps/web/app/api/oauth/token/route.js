import { tokenRequest } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const type = req.headers.get("content-type") ?? "";
  let p = {};
  if (type.includes("application/json")) p = (await req.json().catch(() => ({}))) ?? {};
  else p = Object.fromEntries(new URLSearchParams(await req.text()));
  const out = await tokenRequest(p);
  return Response.json(out, { status: out.error ? 400 : 200, headers: { "cache-control": "no-store", pragma: "no-cache" } });
}

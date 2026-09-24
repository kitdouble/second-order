import { registerClient } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const body = await req.json().catch(() => null);
  const out = await registerClient(body);
  return Response.json(out, { status: out.error ? 400 : 201, headers: { "cache-control": "no-store" } });
}

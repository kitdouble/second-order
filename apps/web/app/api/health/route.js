import { q, dbConfigured } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = "not configured";
  if (dbConfigured()) {
    try {
      await q("SELECT 1");
      db = "ok";
    } catch {
      db = "unreachable";
    }
  }
  return Response.json({ ok: true, service: "web", db, commit: process.env.GIT_COMMIT ?? "local", deployedAt: process.env.DEPLOYED_AT ?? null });
}

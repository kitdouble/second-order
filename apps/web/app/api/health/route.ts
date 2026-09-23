export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    ok: true,
    service: "web",
    commit: process.env.GIT_COMMIT ?? "local",
    deployedAt: process.env.DEPLOYED_AT ?? null,
  });
}

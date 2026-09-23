// Placeholder for the MCP endpoint (https://2ndorder.live/api/mcp).
// The real server (11 tools, OAuth) is built in weeks 7 to 8 of the MVP plan.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { ok: false, message: "MCP server not implemented yet." },
    { status: 501 },
  );
}

export const POST = GET;

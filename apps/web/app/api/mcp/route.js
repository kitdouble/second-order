// MCP endpoint: https://2ndorder.live/api/mcp
import { baseUrlFrom } from "@/lib/url";
import { bearerActor } from "@/lib/oauth";
import { handleRpc } from "@/lib/mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function unauthorized(base) {
  return new Response(JSON.stringify({ error: "unauthorized", error_description: "Connect with OAuth to use Second Order." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`,
    },
  });
}

export async function POST(req) {
  const base = baseUrlFrom(req.headers);
  const actor = await bearerActor(req.headers.get("authorization"));
  if (!actor) return unauthorized(base);
  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, { status: 400 });
  }
  const headers = { "cache-control": "no-store" };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, actor, base)))).filter(Boolean);
    return out.length ? Response.json(out, { headers }) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body, actor, base);
  return out ? Response.json(out, { headers }) : new Response(null, { status: 202 });
}

// No server-initiated streams: this server only answers requests.
export async function GET() {
  return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
}

export async function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

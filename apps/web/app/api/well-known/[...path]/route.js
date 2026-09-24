import { headers } from "next/headers";
import { baseUrlFrom } from "@/lib/url";
import { authServerMetadata, resourceMetadata } from "@/lib/oauth";

export const dynamic = "force-dynamic";

// /.well-known/oauth-authorization-server, /.well-known/openid-configuration,
// /.well-known/oauth-protected-resource[/api/mcp]
export async function GET(_req, { params }) {
  const { path } = await params;
  const base = baseUrlFrom(await headers());
  const name = path[0];
  if (name === "oauth-authorization-server" || name === "openid-configuration") return Response.json(authServerMetadata(base));
  if (name === "oauth-protected-resource") return Response.json(resourceMetadata(base));
  return new Response("Not found", { status: 404 });
}

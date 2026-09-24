import { webActor } from "@/lib/auth";
import { getData, report, getSpec, ServiceError } from "@/lib/studies";

export const dynamic = "force-dynamic";

const TYPES = {
  "participants.csv": "text/csv",
  "trials.csv": "text/csv",
  "analysis.R": "text/plain",
  "prereg.md": "text/markdown",
  "spec.yaml": "text/yaml",
};

export async function GET(req, { params }) {
  const actor = await webActor();
  if (!actor) return new Response("Sign in first.", { status: 401 });
  const { slug, kind } = await params;
  if (!TYPES[kind]) return new Response("Unknown download.", { status: 404 });
  const asked = new URL(req.url).searchParams.get("phase");
  const phase = ["pilot", "preview"].includes(asked) ? asked : "main";
  try {
    let body;
    if (kind === "participants.csv") body = (await getData(actor, slug, { phase, kind: "participants" })).csv;
    else if (kind === "trials.csv") body = (await getData(actor, slug, { phase, kind: "trials", limit: 10_000_000 })).csv;
    else if (kind === "analysis.R") body = (await report(actor, slug, "r_script")).content;
    else if (kind === "prereg.md") body = (await report(actor, slug, "prereg")).content;
    else body = (await getSpec(actor, slug)).yaml;
    const name = `${slug}${phase !== "main" && kind.endsWith(".csv") ? `-${phase}` : ""}-${kind}`;
    return new Response(body, {
      headers: { "content-type": `${TYPES[kind]}; charset=utf-8`, "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" },
    });
  } catch (e) {
    return new Response(e instanceof ServiceError ? e.message : "Server error.", { status: e.status ?? 500 });
  }
}

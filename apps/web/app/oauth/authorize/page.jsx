import Link from "next/link";
import { webActor } from "@/lib/auth";
import { getClient, validRedirect } from "@/lib/oauth";
import { consentAction } from "@/app/actions";

export const dynamic = "force-dynamic";

// Consent screen for connecting Claude or ChatGPT.
export default async function Authorize({ searchParams }) {
  const sp = await searchParams;
  const client = sp.client_id ? await getClient(sp.client_id) : null;
  const bad = (msg) => (
    <div className="hero">
      <h1>Can't connect</h1>
      <p>{msg}</p>
    </div>
  );
  if (!client) return bad("Unknown client. Try adding the connector again.");
  if (!sp.redirect_uri || !client.redirect_uris.includes(sp.redirect_uri) || !validRedirect(sp.redirect_uri)) return bad("The redirect address doesn't match this client.");
  if (sp.response_type !== "code") return bad("Unsupported response type.");
  if (!sp.code_challenge || (sp.code_challenge_method ?? "S256") !== "S256") return bad("This connection needs PKCE (S256).");
  const actor = await webActor();
  if (!actor) {
    return (
      <div className="hero">
        <h1>Sign in first</h1>
        <p>
          Open your Second Order sign-in link in this browser, then try connecting again. <Link href="/">Home</Link>
        </p>
      </div>
    );
  }
  return (
    <div className="hero">
      <h1>Connect {client.client_name}?</h1>
      <p>
        <strong>{client.client_name}</strong> will be able to act as <strong>{actor.user.name}</strong> on Second Order: read your studies and data
        (pseudonymised), save spec versions, run checks, comment and request review
        {actor.user.tier !== "supervised" ? ", and operate Prolific within approved limits" : ""}.
      </p>
      <p className="small muted">It can never approve, start, resume or close a study. You can revoke this any time on the Connect page.</p>
      <form action={consentAction} className="row">
        <input type="hidden" name="client_id" value={sp.client_id} />
        <input type="hidden" name="redirect_uri" value={sp.redirect_uri} />
        <input type="hidden" name="state" value={sp.state ?? ""} />
        <input type="hidden" name="code_challenge" value={sp.code_challenge} />
        <button className="primary" type="submit" name="decision" value="allow">
          Allow
        </button>
        <button type="submit" name="decision" value="deny">
          Cancel
        </button>
      </form>
    </div>
  );
}

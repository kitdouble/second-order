import { headers } from "next/headers";
import { requireActor } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";
import { listConnections } from "@/lib/people";
import { revokeAction } from "@/app/actions";
import { Flash, When } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Connect({ searchParams }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const base = baseUrlFrom(await headers());
  const conns = await listConnections(actor);
  return (
    <>
      <h1>Connect Claude or ChatGPT</h1>
      <Flash sp={sp} />
      <div className="panel">
        <p>Connector URL:</p>
        <pre className="copy">{base}/api/mcp</pre>
        <ol>
          <li>
            <strong>Claude:</strong> Settings → Connectors → Add custom connector. Paste the URL. On Team or Enterprise plans, the workspace owner may
            need to add it first.
          </li>
          <li>
            <strong>ChatGPT:</strong> turn on Developer mode (Settings → Apps/Connectors → Advanced), then create a connector with the URL. Needs a
            paid plan; write tools may be limited on some plans.
          </li>
          <li>You'll be sent here to approve. You must be signed in to this site in the same browser.</li>
          <li>
            Try: “Using Second Order, read the guide, then show me my studies.”
          </li>
        </ol>
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Lab Reviewer (AI review, no extra cost)</h2>
        <p className="small">
          AI verification and design critique run in a separate Claude project so the reviewer never sees the conversation that wrote the study. Set
          it up once:
        </p>
        <ol className="small">
          <li>In Claude, create a project called “Lab Reviewer” with this connector enabled.</li>
          <li>
            Project instructions: <em>“You are the lab's independent study reviewer. When asked, call review with action next_task, follow the
            task's instructions exactly, then call review with action submit_findings. Never edit specs.”</em>
          </li>
          <li>Whenever a review is requested, open that project and say “run the next review task” (repeat until none are left).</li>
        </ol>
      </div>
      <h2>Your connections</h2>
      <div className="panel">
        {conns.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <tbody>
              {conns.map((c) => (
                <tr key={c.client_id}>
                  <td>{c.client_name}</td>
                  <td className="small">
                    Last authorised <When at={c.last_token} />
                  </td>
                  <td>{Number(c.live_tokens) > 0 ? <span className="badge ok">active</span> : <span className="badge">expired</span>}</td>
                  <td>
                    <form action={revokeAction}>
                      <input type="hidden" name="client_id" value={c.client_id} />
                      <button type="submit" className="danger">
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

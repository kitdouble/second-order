import Link from "next/link";
import { dbConfigured } from "@/lib/db";
import { webActor, userCount } from "@/lib/auth";
import { listStudies, reviewQueue } from "@/lib/studies";
import { StatusBadge, Flash, When } from "@/components/ui";
import { PasskeySignIn, AddPasskey } from "@/components/passkey";
import { listPasskeys } from "@/lib/passkeys";
import { headers } from "next/headers";
import { baseUrlFrom } from "@/lib/url";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }) {
  const sp = await searchParams;
  if (!dbConfigured()) {
    return (
      <div className="hero">
        <h1>Second Order</h1>
        <p>The app is running, but no database is connected yet. Follow step 7 in SETUP.md.</p>
      </div>
    );
  }
  const actor = await webActor();
  if (!actor) {
    const n = await userCount();
    return (
      <div className="hero">
        <h1>Second Order</h1>
        <p className="muted">Study platform for the USYD Meta Lab.</p>
        <Flash sp={sp} />
        {n === 0 ? (
          <p>
            First time here? <Link href="/setup">Set up the lab head account</Link>.
          </p>
        ) : (
          <>
            <PasskeySignIn />
            <p className="small muted" style={{ marginTop: 16 }}>
              No passkey yet? Open the sign-in link the lab head sent you, then add a passkey in Settings. Lab head locked out?{" "}
              <Link href="/setup">Recover with the setup code</Link>.
            </p>
          </>
        )}
      </div>
    );
  }
  const [studies, reviews, keys] = await Promise.all([listStudies(actor), reviewQueue(actor), listPasskeys(actor.user.id)]);
  const rpID = new URL(baseUrlFrom(await headers())).hostname;
  const hasKeyHere = keys.some((k) => k.rp_id === rpID);
  return (
    <>
      <Flash sp={sp} />
      {!hasKeyHere && (
        <div className="panel row" style={{ justifyContent: "space-between" }}>
          <span>
            <strong>Add a passkey</strong> so you can sign in with Touch ID, Face ID or your phone instead of waiting for a new link.
          </span>
          <AddPasskey />
        </div>
      )}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Studies</h1>
        <Link className="btn primary" href="/studies/new">
          New study
        </Link>
      </div>
      {reviews.length > 0 && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>Waiting for review</h2>
          <table>
            <tbody>
              {reviews.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/studies/${r.slug}`}>{r.title}</Link>
                  </td>
                  <td>{r.gate === "pilot" ? "Approve for pilot" : "Approve go-live"}</td>
                  <td className="muted">{r.requested_by}</td>
                  <td className="muted small">{r.summary}</td>
                  <td className="small">
                    <When at={r.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel tablewrap">
        {studies.length === 0 ? (
          <p className="muted">
            No studies yet. <Link href="/studies/new">Start from the example</Link>, or ask Claude to draft one through the connector.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Study</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Open findings</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {studies.map((s) => (
                <tr key={s.slug}>
                  <td>
                    <Link href={`/studies/${s.slug}`}>{s.title}</Link>
                    <div className="muted small">{s.slug}</div>
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                    {s.status_note && <div className="muted small">{s.status_note}</div>}
                  </td>
                  <td>{s.owner_name}</td>
                  <td>{Number(s.open_findings) > 0 ? <span className="badge warn">{s.open_findings}</span> : <span className="muted">0</span>}</td>
                  <td className="small">
                    <When at={s.updated_at} />
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

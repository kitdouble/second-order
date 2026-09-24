import Link from "next/link";
import { requireActor } from "@/lib/auth";
import { one } from "@/lib/db";
import { personSummary } from "@/lib/studies";
import { meetingAction } from "@/app/actions";
import { StatusBadge, SeverityBadge, Flash, When } from "@/components/ui";

export const dynamic = "force-dynamic";

// Meeting prep: everything that changed since the last meeting you marked.
export default async function Person({ params, searchParams }) {
  const actor = await requireActor();
  const { id } = await params;
  const sp = await searchParams;
  if (actor.user.tier !== "lab_head" && actor.user.id !== id) return <p>Not available.</p>;
  const u = await one("SELECT name FROM users WHERE id = $1", [id]);
  if (!u) return <p>No such person.</p>;
  const d = await personSummary(actor, u.name);
  return (
    <>
      <Flash sp={sp} />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>{d.person}</h1>
        {actor.user.tier === "lab_head" && (
          <form action={meetingAction}>
            <input type="hidden" name="id" value={id} />
            <button type="submit">Mark meeting held</button>
          </form>
        )}
      </div>
      <p className="muted small">
        {d.since_last_meeting ? (
          <>
            Showing changes since the last meeting (<When at={d.since_last_meeting} />).
          </>
        ) : (
          "No meeting marked yet; showing recent activity."
        )}
      </p>
      <h2>Studies</h2>
      <div className="panel">
        {d.studies.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <table>
            <tbody>
              {d.studies.map((s) => (
                <tr key={s.slug}>
                  <td>
                    <Link href={`/studies/${s.slug}`}>{s.title}</Link>
                  </td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="small muted">{s.status_note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="grid2">
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Open findings</h3>
          {d.open_findings.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="findings">
              {d.open_findings.map((f, i) => (
                <li key={i} className="small">
                  <SeverityBadge severity={f.severity} /> <strong>{f.slug}</strong>: {f.body}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>AI points they dismissed</h3>
          <p className="small muted">A ready-made supervision agenda.</p>
          {d.dismissed_ai_points.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="findings">
              {d.dismissed_ai_points.map((f, i) => (
                <li key={i} className="small">
                  <strong>{f.slug}</strong>: {f.finding}
                  <div className="muted">Their reason: {f.resolution}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h2>Activity</h2>
      <div className="panel tablewrap">
        <table>
          <tbody>
            {d.recent_activity.map((a, i) => (
              <tr key={i} className="small">
                <td>
                  <When at={a.at} />
                </td>
                <td>{a.slug}</td>
                <td>{a.action.replaceAll("_", " ")}</td>
                <td className="muted">{a.client}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

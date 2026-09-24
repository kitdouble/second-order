import { requireActor } from "@/lib/auth";
import { auditLog } from "@/lib/people";
import { When } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Audit() {
  const actor = await requireActor();
  if (actor.user.tier !== "lab_head") return <p>Only the lab head sees the audit log.</p>;
  const rows = await auditLog(actor);
  return (
    <>
      <h1>Audit log</h1>
      <p className="muted small">Every action, by whom and through which client. Append-only.</p>
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Client</th>
              <th>Action</th>
              <th>Study</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="small">
                <td>
                  <When at={r.at} />
                </td>
                <td>{r.user_name ?? "platform"}</td>
                <td className="muted">{r.client}</td>
                <td>{r.action.replaceAll("_", " ")}</td>
                <td>{r.slug}</td>
                <td className="muted">
                  <code>{JSON.stringify(r.detail)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

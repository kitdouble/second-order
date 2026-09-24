import Link from "next/link";
import { requireActor, TIERS } from "@/lib/auth";
import { listPeople } from "@/lib/people";
import { addPersonAction, issueLinkAction, setTierAction, disableAction } from "@/app/actions";
import { Flash, When } from "@/components/ui";
import { TRUSTED_CAP } from "@/lib/studies";

export const dynamic = "force-dynamic";

export default async function People({ searchParams }) {
  const actor = await requireActor();
  const sp = await searchParams;
  if (actor.user.tier !== "lab_head") return <p>Only the lab head manages people.</p>;
  const people = await listPeople(actor);
  return (
    <>
      <h1>People</h1>
      <p className="muted small">
        Lab head: approves anything. Trusted: approves their own studies up to {TRUSTED_CAP} estimated spend. Supervised: needs your approval at every
        gate and can't operate Prolific. Every tier gets the same AI checks.
      </p>
      <Flash sp={sp} />
      {sp.link && (
        <div className="panel">
          <strong>Sign-in link for {sp.for}</strong> (one use, valid 7 days). Send it to them privately:
          <pre className="copy">{sp.link}</pre>
        </div>
      )}
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Add someone</h2>
        <form action={addPersonAction} className="inline">
          <input name="name" placeholder="Name" required />
          <select name="tier" defaultValue="supervised">
            <option value="supervised">Supervised</option>
            <option value="trusted">Trusted</option>
            <option value="lab_head">Lab head</option>
          </select>
          <button className="primary" type="submit">
            Add and make sign-in link
          </button>
        </form>
      </div>
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Tier</th>
              <th>Studies</th>
              <th>Last sign-in</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.id} style={p.disabled ? { opacity: 0.5 } : null}>
                <td>
                  <Link href={`/people/${p.id}`}>{p.name}</Link>
                  {p.disabled && <span className="badge"> disabled</span>}
                </td>
                <td>
                  <form action={setTierAction} className="inline">
                    <input type="hidden" name="id" value={p.id} />
                    <select name="tier" defaultValue={p.tier}>
                      {Object.entries(TIERS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                    <button type="submit">Set</button>
                  </form>
                </td>
                <td>{p.studies}</td>
                <td className="small">
                  <When at={p.last_sign_in} />
                </td>
                <td>
                  <div className="row">
                    <form action={issueLinkAction} className="inline">
                      <input type="hidden" name="id" value={p.id} />
                      <button type="submit">New sign-in link</button>
                    </form>
                    {p.id !== actor.user.id && (
                      <form action={disableAction} className="inline">
                        <input type="hidden" name="id" value={p.id} />
                        <input type="hidden" name="disabled" value={p.disabled ? "0" : "1"} />
                        <button type="submit" className={p.disabled ? "" : "danger"}>
                          {p.disabled ? "Enable" : "Disable"}
                        </button>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

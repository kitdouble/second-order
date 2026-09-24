import { requireActor } from "@/lib/auth";
import { listLibrary } from "@/lib/library";
import { tryTaskAction, retireTaskAction } from "@/app/actions";
import { Flash, When } from "@/components/ui";

export const dynamic = "force-dynamic";

function Columns({ columns }) {
  if (!columns || typeof columns !== "object") return <span className="muted">{columns ?? ""}</span>;
  return <span className="small muted">{Object.keys(columns).join(", ")}</span>;
}

function Verified({ ok }) {
  return ok ? (
    <span className="badge ok" title="Simulation, power analysis and QA work for this task.">verified</span>
  ) : (
    <span className="badge warn" title="Custom code: no simulation or power analysis. Pilot it.">unverified</span>
  );
}

function TryButton({ target }) {
  return (
    <form action={tryTaskAction} className="inline">
      <input type="hidden" name="target" value={target} />
      <button type="submit">Try it</button>
    </form>
  );
}

export default async function Library({ searchParams }) {
  const actor = await requireActor();
  const sp = await searchParams;
  const lib = await listLibrary();
  const head = actor.user.tier === "lab_head";
  return (
    <>
      <h1>Library</h1>
      <p className="muted small">
        Tasks you can use in a study. Ask Claude for one by name, e.g. “use the lab’s go-nogo task”. <b>Try it</b> runs the task on its own.
        Nothing you do there is analysed.
      </p>
      <Flash sp={sp} />

      <h2>Lab tasks</h2>
      {lib.lab.length === 0 ? (
        <div className="panel muted">
          Nothing here yet.{" "}
          {head
            ? "To add one, ask Claude: “add the <step> step from <study> to the lab library as <name>”."
            : "The lab head adds tasks from studies."}
        </div>
      ) : (
        <div className="panel tablewrap">
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Records</th>
                <th>Used by</th>
                <th>Added</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {lib.lab.map((t) => (
                <tr key={t.ref}>
                  <td>
                    <strong>{t.title}</strong> <code className="small">{t.ref}</code> <Verified ok={t.verified} />
                    <div className="small">{t.description}</div>
                    <div className="small muted">
                      {t.block}
                      {t.from ? ` · from ${t.from}` : ""}
                    </div>
                    {t.suggestion && <div className="small">{t.suggestion}</div>}
                  </td>
                  <td>
                    <Columns columns={t.columns} />
                  </td>
                  <td>{t.used_by_studies} {t.used_by_studies === 1 ? "study" : "studies"}</td>
                  <td className="small">
                    {t.added_by}
                    <br />
                    <When at={t.added} />
                  </td>
                  <td>
                    <div className="row">
                      <TryButton target={t.name} />
                      {head && (
                        <form action={retireTaskAction} className="inline">
                          <input type="hidden" name="name" value={t.name} />
                          <button type="submit" title="Existing studies keep working; new studies can't use it as vetted code.">
                            Retire
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
      )}

      <h2>Built-in blocks</h2>
      <div className="panel tablewrap">
        <table>
          <thead>
            <tr>
              <th>Block</th>
              <th>Records</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lib.builtin.map((b) => (
              <tr key={b.ref}>
                <td>
                  <strong>{b.title}</strong> <code className="small">{b.ref}</code> <Verified ok={b.verified} />
                  <div className="small">{b.description}</div>
                </td>
                <td>
                  <Columns columns={b.columns} />
                </td>
                <td>{b.can_try && <TryButton target={b.ref} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

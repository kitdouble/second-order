import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";
import { studyPageData, studyLink, ServiceError, TRUSTED_CAP } from "@/lib/studies";
import {
  saveSpecAction,
  qaAction,
  simAction,
  previewAction,
  requestReviewAction,
  decideAction,
  commentAction,
  resolveAction,
  startAction,
  runStateAction,
  forkAction,
} from "@/app/actions";
import { StatusBadge, SeverityBadge, Flash, When, fmt } from "@/components/ui";

export const dynamic = "force-dynamic";

const TABS = [
  ["overview", "Overview"],
  ["spec", "Spec"],
  ["checks", "Checks"],
  ["review", "Review"],
  ["data", "Data"],
  ["history", "History"],
];

export default async function StudyPage({ params, searchParams }) {
  const actor = await requireActor();
  const { slug } = await params;
  const sp = await searchParams;
  let d;
  try {
    d = await studyPageData(actor, slug);
  } catch (e) {
    if (e instanceof ServiceError && e.status === 404) notFound();
    throw e;
  }
  const base = baseUrlFrom(await headers());
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab : "overview";
  const s = d.study;
  const openFindings = d.comments.filter((c) => c.status === "open" && c.severity);
  const blockers = openFindings.filter((c) => c.severity === "blocker");

  return (
    <>
      <Flash sp={sp} />
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>{s.title}</h1>
          <div className="row small muted">
            <code>{s.slug}</code>
            <StatusBadge status={s.status} />
            <span>Owner: {s.owner_name}</span>
            {d.current && <span>Current {d.current.hash.slice(0, 12)}</span>}
            {s.approved_hash && <span>Approved {s.approved_hash.slice(0, 12)}</span>}
          </div>
          {s.status_note && <p className="small">{s.status_note}</p>}
        </div>
      </div>

      <NextStep d={d} base={base} blockers={blockers} actor={actor} />

      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <Link key={k} href={`/studies/${s.slug}?tab=${k}`} className={k === tab ? "on" : ""}>
            {label}
            {k === "review" && openFindings.length ? ` (${openFindings.length})` : ""}
          </Link>
        ))}
      </nav>

      {tab === "overview" && <Overview d={d} />}
      {tab === "spec" && <SpecTab d={d} />}
      {tab === "checks" && <ChecksTab d={d} sp={sp} />}
      {tab === "review" && <ReviewTab d={d} />}
      {tab === "data" && <DataTab d={d} />}
      {tab === "history" && <HistoryTab d={d} />}
    </>
  );
}

function Hidden({ slug }) {
  return <input type="hidden" name="slug" value={slug} />;
}

function NextStep({ d, base, blockers }) {
  const s = d.study;
  const v = d.current;
  const dep = d.status.deployment;
  const link = dep && ["active", "paused"].includes(dep.status) ? studyLink(base, s.live_hash && dep.phase === "main" ? s.live_hash : s.approved_hash) : null;
  const openReview = d.review?.status === "open" ? d.review : null;
  const panel = (children) => <div className="panel">{children}</div>;

  if (!v) return panel(<p>No spec yet.</p>);
  if (!v.validation.ok) {
    return panel(
      <>
        <strong>Next: fix {v.validation.errors.length} validation error(s).</strong>{" "}
        <Link href={`/studies/${s.slug}?tab=spec`}>Open the spec</Link> or ask Claude to fix them.
      </>,
    );
  }

  const running = (
    <>
      {link && (
        <>
          <label>Study link for Prolific (paste exactly, including the placeholders)</label>
          <pre className="copy">{link}</pre>
        </>
      )}
      <div className="row">
        {dep?.status === "active" && (
          <form action={runStateAction} className="inline">
            <Hidden slug={s.slug} />
            <input type="hidden" name="action" value="pause" />
            <button type="submit">Pause</button>
          </form>
        )}
        {dep?.phase === "pilot" && dep?.status === "active" && (
          <form action={runStateAction} className="inline">
            <Hidden slug={s.slug} />
            <input type="hidden" name="action" value="end_pilot" />
            <button type="submit">End pilot now and run checks</button>
          </form>
        )}
      </div>
    </>
  );

  switch (s.status) {
    case "draft":
      if (!d.qa)
        return panel(
          <form action={qaAction} className="inline">
            <strong>Next: run QA on this version.</strong>
            <Hidden slug={s.slug} />
            <button className="primary" type="submit">
              Run QA
            </button>
          </form>,
        );
      if (!d.qa.ok) return panel(<strong>QA found blockers. See the Checks tab.</strong>);
      return panel(
        <form action={requestReviewAction}>
          <strong>Next: request review for the pilot.</strong>
          <Hidden slug={s.slug} />
          <label htmlFor="summary">What should the reviewer know? (optional)</label>
          <input id="summary" name="summary" style={{ width: "100%" }} />
          <p className="small muted">
            Estimated spend: pilot {d.spend?.pilot ?? "?"} {d.spend?.currency}, main {d.spend?.main ?? "?"} {d.spend?.currency} (rewards plus Prolific's fee).
            Before a person reviews, preview each condition from the Checks tab.
          </p>
          <button className="primary" type="submit">
            Request review
          </button>
        </form>,
      );
    case "in_review":
      return panel(<ApproveBox d={d} review={openReview} blockers={blockers} />);
    case "approved":
      return panel(
        <form action={startAction}>
          <strong>Approved for pilot. Next: start the pilot.</strong>
          <p className="small muted">
            Create the study on Prolific first (you do this by hand), with {d.spend ? "the" : ""} pilot places. Then enter its details here. The
            platform stops the pilot automatically when every condition has its pilot N.
          </p>
          <Hidden slug={s.slug} />
          <input type="hidden" name="phase" value="pilot" />
          <div className="row">
            <div>
              <label>Prolific study ID (optional, lets the platform pause it)</label>
              <input name="prolific_study_id" />
            </div>
            <div>
              <label>Completion code</label>
              <input name="completion_code" required />
            </div>
          </div>
          <p>
            <button className="primary" type="submit">
              Start pilot
            </button>
          </p>
        </form>,
      );
    case "piloting":
      return panel(
        <>
          <strong>Pilot running.</strong> {pilotProgress(d)}
          {running}
        </>,
      );
    case "pilot_review": {
      const pr = d.status.pilot_report;
      const edited = s.current_hash !== s.approved_hash;
      return panel(
        <>
          <strong>Pilot finished.</strong>{" "}
          {pr && (
            <span>
              {pr.n_sessions} sessions; {pr.blockers_failed} blocker check(s) failed. <Link href={`/studies/${s.slug}?tab=checks`}>See the pilot report.</Link>
            </span>
          )}
          {edited && <p>You edited the spec after the pilot. The new version needs review and a fresh pilot.</p>}
          {openReview ? (
            <ApproveBox d={d} review={openReview} blockers={blockers} />
          ) : d.goLiveApproved && !edited ? (
            <form action={startAction}>
              <p>
                <strong>Go-live approved. Next: start main data collection.</strong>
              </p>
              <Hidden slug={s.slug} />
              <input type="hidden" name="phase" value="main" />
              <div className="row">
                <div>
                  <label>Prolific study ID (optional)</label>
                  <input name="prolific_study_id" />
                </div>
                <div>
                  <label>Completion code</label>
                  <input name="completion_code" required />
                </div>
              </div>
              <p>
                <button className="primary" type="submit">
                  Start main collection
                </button>
              </p>
            </form>
          ) : (
            <form action={requestReviewAction}>
              <Hidden slug={s.slug} />
              <label htmlFor="summary">{edited ? "What changed after the pilot?" : "Notes for go-live review (optional)"}</label>
              <input id="summary" name="summary" style={{ width: "100%" }} />
              <p>
                <button className="primary" type="submit">
                  {edited ? "Request review for a new pilot" : "Request go-live review"}
                </button>
              </p>
            </form>
          )}
        </>,
      );
    }
    case "live":
      return panel(
        <>
          <strong>Collecting data.</strong> {liveProgress(d)}
          {running}
        </>,
      );
    case "paused":
      return panel(
        <>
          <strong>Paused.</strong> {s.status_note}
          {link && <pre className="copy">{link}</pre>}
          <form action={runStateAction}>
            <Hidden slug={s.slug} />
            <input type="hidden" name="action" value="resume" />
            <label>Reason (required if the stopping rule or max N paused it; that's a deviation)</label>
            <input name="note" style={{ width: "100%" }} />
            <p className="row">
              <button type="submit">Resume</button>
            </p>
          </form>
          <form action={runStateAction} className="inline">
            <Hidden slug={s.slug} />
            <input type="hidden" name="action" value="close" />
            <button type="submit" className="danger">
              Close study
            </button>
          </form>
        </>,
      );
    default:
      return panel(<span>Closed. Data and reports are in the Data tab.</span>);
  }
}

function pilotProgress(d) {
  const rows = d.status.by_condition;
  if (!rows.length) return "No sessions yet.";
  return rows.map((r) => `${r.condition}: ${r.complete} complete`).join(" · ");
}

function liveProgress(d) {
  const rows = d.status.by_condition;
  const last = d.status.stop_checks[0];
  return (
    <>
      {rows.map((r) => `${r.condition}: ${r.included} included of ${r.complete}`).join(" · ") || "No sessions yet."}
      {last && ` · last check BF10 = ${fmt(last.bf10)} at ${last.n_included} included`}
    </>
  );
}

function ApproveBox({ d, review, blockers }) {
  if (!review) return null;
  const s = d.study;
  const gate = review.gate === "pilot" ? "pilot" : "go-live";
  return (
    <>
      <p>
        <strong>Review requested ({gate})</strong> by {review.requested_by_name}
        {review.summary && <>: “{review.summary}”</>}
      </p>
      {d.aiTasks.length > 0 && (
        <p className="small muted">
          AI review queued ({d.aiTasks.map((t) => t.kind.replace("_", " ")).join(", ")}). Ask your Lab Reviewer project in Claude to "run the next review task".
        </p>
      )}
      {blockers.length > 0 && <p className="small">{blockers.length} blocker finding(s) must be accepted or dismissed before approval.</p>}
      {d.approve?.ok ? (
        <form action={decideAction}>
          <Hidden slug={s.slug} />
          <label>Note (optional)</label>
          <input name="note" style={{ width: "100%" }} />
          <p className="small muted">
            Before approving: preview each condition (Checks tab), read the diff and QA. A clean AI review means “no issues found”, not “passed”.
          </p>
          <div className="row">
            <button className="primary" type="submit" name="decision" value="approve">
              Approve {gate}
            </button>
            <button type="submit" name="decision" value="changes">
              Request changes
            </button>
          </div>
        </form>
      ) : (
        <p className="small muted">{d.approve?.reason ?? "Waiting for approval."}</p>
      )}
    </>
  );
}

function Overview({ d }) {
  const v = d.current;
  const st = d.status;
  return (
    <div className="grid2">
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Validation</h3>
        {!v ? (
          <p className="muted">No spec.</p>
        ) : v.validation.ok ? (
          <p>
            <span className="badge ok">Valid</span>
          </p>
        ) : (
          <IssueList items={v.validation.errors} kind="bad" />
        )}
        {v?.validation.warnings?.length > 0 && (
          <>
            <h3>Warnings</h3>
            <IssueList items={v.validation.warnings} kind="warn" />
          </>
        )}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Changes</h3>
        {d.approvedDiff ? (
          <>
            <p className="small muted">Since the approved version:</p>
            <DiffList diff={d.approvedDiff} />
          </>
        ) : d.parentDiff ? (
          <>
            <p className="small muted">Since the previous version:</p>
            <DiffList diff={d.parentDiff} />
          </>
        ) : (
          <p className="muted">First version.</p>
        )}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Participants</h3>
        {st.by_condition.length ? (
          <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Condition</th>
                <th>In progress</th>
                <th>Complete</th>
                <th>Included</th>
              </tr>
            </thead>
            <tbody>
              {st.by_condition.map((r) => (
                <tr key={r.condition}>
                  <td>{r.condition}</td>
                  <td>{r.in_progress}</td>
                  <td>{r.complete}</td>
                  <td>{r.included}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <p className="muted">No data collection yet.</p>
        )}
        {Object.keys(st.exclusion_counts).length > 0 && (
          <p className="small muted">
            Exclusions: {Object.entries(st.exclusion_counts).map(([k, n]) => `${k} ${n}`).join(" · ")}
          </p>
        )}
      </div>
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Stopping rule</h3>
        {st.stop_checks.length ? (
          <table>
            <thead>
              <tr>
                <th>Included</th>
                <th>n per group</th>
                <th>BF10</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {st.stop_checks.map((c, i) => (
                <tr key={i}>
                  <td>{c.n_included}</td>
                  <td>
                    {c.n_x ?? "—"} / {c.n_y ?? "—"}
                  </td>
                  <td>{fmt(c.bf10)}</td>
                  <td>{c.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">Checked automatically after each completed session once data collection starts.</p>
        )}
      </div>
    </div>
  );
}

function IssueList({ items, kind }) {
  return (
    <ul className="findings">
      {items.map((e, i) => (
        <li key={i}>
          <span className={`badge ${kind}`}>{e.path}</span> {e.message}
        </li>
      ))}
    </ul>
  );
}

function DiffList({ diff }) {
  return (
    <>
      <p className="small">{diff.summary}</p>
      <ul className="small">
        {diff.major.map((c, i) => (
          <li key={`M${i}`}>
            <strong>{c.sentence}</strong>
          </li>
        ))}
        {diff.minor.map((c, i) => (
          <li key={`m${i}`} className="muted">
            {c.sentence}
          </li>
        ))}
      </ul>
    </>
  );
}

function SpecTab({ d }) {
  const s = d.study;
  return (
    <>
      {!d.canEdit && <p className="muted">Read only: this study belongs to {s.owner_name}.</p>}
      <form action={saveSpecAction}>
        <Hidden slug={s.slug} />
        <input type="hidden" name="base_hash" value={d.current?.hash ?? ""} />
        <textarea className="code" name="yaml" defaultValue={d.current?.yaml ?? ""} spellCheck={false} readOnly={!d.canEdit} />
        {d.canEdit && (
          <>
            <label>What changed and why</label>
            <input name="message" style={{ width: "100%" }} />
            <p className="small muted">Saving makes a new version and cancels any pending approval.</p>
            <button className="primary" type="submit">
              Save new version
            </button>
          </>
        )}
      </form>
      <h2>Fork</h2>
      <form action={forkAction} className="inline">
        <input type="hidden" name="from" value={s.slug} />
        <input name="new_slug" placeholder="new-study-slug" required pattern="[a-z0-9][a-z0-9-]{1,62}" />
        <input name="title" placeholder="Title (e.g. Experiment 4)" />
        <button type="submit">Fork this study</button>
      </form>
    </>
  );
}

function ChecksTab({ d, sp }) {
  const s = d.study;
  let preview = null;
  try {
    preview = sp.pv ? JSON.parse(sp.pv) : null;
  } catch {}
  return (
    <>
      <div className="row">
        <form action={qaAction} className="inline">
          <Hidden slug={s.slug} />
          <button type="submit">Run QA</button>
        </form>
        <form action={simAction} className="inline">
          <Hidden slug={s.slug} />
          <input name="reps" defaultValue="50" size={4} aria-label="Simulation runs" />
          <button type="submit">Run simulation</button>
        </form>
        <form action={previewAction} className="inline">
          <Hidden slug={s.slug} />
          <button type="submit">Make preview links</button>
        </form>
      </div>
      {preview && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>Preview links (valid 3 days; data kept separate)</h3>
          <table>
            <tbody>
              {preview.map((p) => (
                <tr key={p.condition}>
                  <td>{p.condition}</td>
                  <td>
                    <a href={p.full} target="_blank" rel="noreferrer">
                      Full
                    </a>
                  </td>
                  <td>
                    <a href={p.quick} target="_blank" rel="noreferrer">
                      Quick (6 trials per task)
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>QA {d.qaAt && <span className="small muted">· <When at={d.qaAt} /></span>}</h2>
      {!d.qa ? (
        <p className="muted">Not run on this version.</p>
      ) : (
        <div className="panel">
          <p>
            {d.qa.ok ? <span className="badge ok">No blockers</span> : <span className="badge bad">Blockers</span>} · estimated {d.qa.est_minutes} min
          </p>
          {d.qa.findings.length > 0 && (
            <ul className="findings">
              {d.qa.findings.map((f, i) => (
                <li key={i}>
                  <SeverityBadge severity={f.severity === "blocker" ? "blocker" : "concern"} /> {f.message}
                </li>
              ))}
            </ul>
          )}
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Condition</th>
                  <th>Steps (rows)</th>
                  <th>Synthetic participant</th>
                </tr>
              </thead>
              <tbody>
                {d.qa.conditions.map((c) => (
                  <tr key={c.condition}>
                    <td>{c.condition}</td>
                    <td className="small">
                      {c.steps.map((st) => (
                        <div key={st.id}>
                          {st.id}: {st.rows}
                          {st.key_params?.feedback ? ` · feedback ${st.key_params.feedback}` : ""}
                          {!st.recorded ? " · not recorded" : ""}
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {Object.entries(c.measures).map(([k, v]) => (
                        <div key={k}>
                          {k}: {fmt(v, 3)}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted">Not checked here: {d.qa.not_checked.join(" ")}</p>
        </div>
      )}

      <h2>Simulation {d.simAt && <span className="small muted">· <When at={d.simAt} /></span>}</h2>
      {!d.sim ? (
        <p className="muted">Not run on this version.</p>
      ) : (
        <div className="panel">
          <p className="small">
            {d.sim.reps_done} simulated studies{d.sim.truncated ? " (time limit reached)" : ""} · exclusion rate {fmt(d.sim.exclusion_rate)}
          </p>
          {d.sim.sequential && (
            <p>
              Sequential design: stops for H1 in <strong>{d.sim.sequential.pct_stop_for_h1}%</strong>, for H0 in{" "}
              <strong>{d.sim.sequential.pct_stop_for_h0}%</strong>, reaches max N in {d.sim.sequential.pct_reach_max}%; mean{" "}
              {d.sim.sequential.mean_included_n_at_stop} included at stop.
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>n per group</th>
                <th>BF10 ≥ 10</th>
                <th>BF10 ≤ 0.1</th>
                <th>Inconclusive</th>
              </tr>
            </thead>
            <tbody>
              {d.sim.fixed_n.map((r) => (
                <tr key={r.n_per_group_before_exclusions}>
                  <td>{r.n_per_group_before_exclusions}</td>
                  <td>{r.pct_bf_over_10}%</td>
                  <td>{r.pct_bf_under_0_1}%</td>
                  <td>{r.pct_inconclusive}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {d.sim.parameter_recovery && (
            <p className="small">
              Parameter recovery: true vs estimated r = <strong>{fmt(d.sim.parameter_recovery.correlation_true_vs_estimated)}</strong> (
              {d.sim.parameter_recovery.n} synthetic participants).
            </p>
          )}
          <p className="small muted">{d.sim.note}</p>
        </div>
      )}

      {d.status.pilot_report && (
        <>
          <h2>Pilot report</h2>
          <div className="panel">
            <p>
              {d.status.pilot_report.n_sessions} sessions · {d.status.pilot_report.blockers_failed} blocker check(s) failed
            </p>
            <table>
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Expect</th>
                  <th>Observed</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {d.status.pilot_report.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>
                      <code>{c.expect}</code>
                    </td>
                    <td>{typeof c.observed === "object" ? JSON.stringify(c.observed) : fmt(c.observed, 3)}</td>
                    <td>
                      {c.pass ? <span className="badge ok">pass</span> : <span className={`badge ${c.level === "blocker" ? "bad" : "warn"}`}>fail ({c.level})</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function ReviewTab({ d }) {
  const s = d.study;
  const open = d.comments.filter((c) => c.status === "open");
  const closed = d.comments.filter((c) => c.status !== "open");
  return (
    <>
      <h2>Open findings and comments</h2>
      {open.length === 0 && <p className="muted">Nothing open.</p>}
      <ul className="findings">
        {open.map((c) => (
          <li key={c.id}>
            <div className="row small muted">
              {c.severity && <SeverityBadge severity={c.severity} />}
              <span>{c.source === "human" ? c.author_name : c.source === "ai_critic" ? "Design critic" : "AI reviewer"}</span>
              {c.path && <code>{c.path}</code>}
              <When at={c.created_at} />
            </div>
            <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{c.body}</p>
            {c.severity && (
              <form action={resolveAction} className="inline">
                <Hidden slug={s.slug} />
                <input type="hidden" name="id" value={c.id} />
                <input name="resolution" placeholder="One line on why" required size={40} />
                <button type="submit" name="status" value="accepted">
                  Accept
                </button>
                <button type="submit" name="status" value="dismissed">
                  Dismiss
                </button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <h2>Add a comment</h2>
      <form action={commentAction}>
        <Hidden slug={s.slug} />
        <textarea name="body" rows={3} required />
        <div className="row">
          <select name="severity" defaultValue="">
            <option value="">Comment</option>
            <option value="blocker">Blocker</option>
            <option value="concern">Concern</option>
            <option value="consider">Consider</option>
          </select>
          <input name="path" placeholder="Spec path or step (optional)" />
          <button type="submit">Add</button>
        </div>
      </form>
      {closed.length > 0 && (
        <>
          <h2>Resolved and notes</h2>
          <ul className="findings">
            {closed.map((c) => (
              <li key={c.id} className="small">
                <div className="row muted">
                  {c.severity && <SeverityBadge severity={c.severity} />}
                  <span>{c.source === "human" ? c.author_name : c.source === "ai_critic" ? "Design critic" : "AI reviewer"}</span>
                  <span className="badge">{c.status}</span>
                  <When at={c.created_at} />
                </div>
                <p style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>{c.body}</p>
                {c.resolution && (
                  <p className="muted" style={{ margin: 0 }}>
                    {c.resolved_by_name}: {c.resolution}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function DataTab({ d }) {
  const s = d.study;
  const dl = (kind, label, phase) => (
    <a className="btn" href={`/studies/${s.slug}/download/${kind}${phase ? `?phase=${phase}` : ""}`}>
      {label}
    </a>
  );
  return (
    <>
      <h2>Downloads</h2>
      <div className="row">
        {dl("participants.csv", "participants.csv")}
        {dl("trials.csv", "trials.csv")}
        {dl("participants.csv", "Pilot participants.csv", "pilot")}
        {dl("trials.csv", "Pilot trials.csv", "pilot")}
        {dl("analysis.R", "analysis.R")}
        {dl("prereg.md", "prereg.md")}
        {dl("spec.yaml", "spec.yaml")}
      </div>
      <p className="small muted">
        Put trials.csv and participants.csv next to analysis.R and run it: it recomputes every measure, exclusion and the Bayes factor, and checks them
        against the platform's numbers. The R output is the result of record.
      </p>
      <h2>Saved analyses and notes</h2>
      {d.saved.length === 0 ? (
        <p className="muted">Nothing saved yet. Claude saves analyses here with the save tool.</p>
      ) : (
        d.saved.map((i) => (
          <div className="panel" key={i.id}>
            <div className="row small muted">
              <span className="badge">{i.kind}</span>
              {i.exploratory && <span className="badge warn">exploratory</span>}
              <strong>{i.title}</strong>
              <span>{i.author}</span>
              <span>via {i.created_via}</span>
              {i.data_hash && <code>data {i.data_hash}</code>}
              <When at={i.created_at} />
            </div>
            <pre>{i.content}</pre>
          </div>
        ))
      )}
    </>
  );
}

function HistoryTab({ d }) {
  return (
    <div className="panel tablewrap">
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Valid</th>
            <th>Message</th>
            <th>By</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {d.versions.map((v) => (
            <tr key={v.hash}>
              <td>
                <code>{v.short}</code>
                {v.hash === d.study.current_hash && <span className="badge info"> current</span>}
                {v.hash === d.study.approved_hash && <span className="badge ok"> approved</span>}
              </td>
              <td>{v.valid ? "yes" : <span className="badge bad">no</span>}</td>
              <td className="small">{v.message}</td>
              <td className="small">
                {v.author} <span className="muted">({v.created_via})</span>
              </td>
              <td className="small">
                <When at={v.created_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted">Self-approval limit for trusted members: {TRUSTED_CAP} (study currency, including Prolific's fee).</p>
    </div>
  );
}

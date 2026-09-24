// Small shared UI pieces (server components).

const STATUS = {
  draft: ["Draft", ""],
  in_review: ["In review", "info"],
  approved: ["Approved for pilot", "ok"],
  piloting: ["Piloting", "warn"],
  pilot_review: ["Pilot review", "info"],
  live: ["Live", "ok"],
  paused: ["Paused", "warn"],
  closed: ["Closed", ""],
};

export function StatusBadge({ status }) {
  const [label, cls] = STATUS[status] ?? [status, ""];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function SeverityBadge({ severity }) {
  const cls = severity === "blocker" ? "bad" : severity === "concern" ? "warn" : "info";
  return <span className={`badge ${cls}`}>{severity}</span>;
}

export function Flash({ sp }) {
  if (sp?.err) return <div className="flash err">{sp.err}</div>;
  if (sp?.msg) return <div className="flash ok">{sp.msg}</div>;
  return null;
}

export function When({ at }) {
  if (!at) return <span className="muted">—</span>;
  const d = new Date(at);
  return (
    <time dateTime={d.toISOString()} title={d.toISOString()}>
      {d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Australia/Sydney" })}
    </time>
  );
}

export function Json({ value }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export const fmt = (x, d = 2) => (typeof x === "number" && Number.isFinite(x) ? x.toFixed(d) : x ?? "—");

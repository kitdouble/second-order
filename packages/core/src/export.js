// Tidy CSV exports: one row per trial, and one row per participant.
// Pseudonymised: session ids only; Prolific IDs never leave the platform.

function csvCell(v) {
  if (v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "NA";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  return [header.map(csvCell).join(","), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(","))].join("\n") + "\n";
}

/**
 * sessions: [{ session_id, condition, levels, rows: { [step]: [data...] } }]
 */
export function trialsCsv(spec, sessions) {
  const factors = Object.keys(spec.design.between);
  const cols = new Set();
  const out = [];
  for (const s of sessions) {
    for (const [step, rows] of Object.entries(s.rows)) {
      rows.forEach((r, i) => {
        for (const k of Object.keys(r)) cols.add(k);
        out.push({ session_id: s.session_id, condition: s.condition, ...s.levels, step, trial_index: i, ...r });
      });
    }
  }
  const dataCols = [...cols].filter((c) => !["session_id", "condition", "step", "trial_index", ...factors].includes(c));
  return toCsv(["session_id", "condition", ...factors, "step", "trial_index", ...dataCols], out);
}

/** sessions must carry `scored` from scoreParticipant. */
export function participantsCsv(spec, sessions) {
  const factors = Object.keys(spec.design.between);
  const measureNames = Object.keys(spec.measures);
  const summaryCols = new Set();
  const rows = sessions.map((s) => {
    const r = { session_id: s.session_id, condition: s.condition, ...s.levels, status: s.status ?? "complete" };
    for (const [id, sum] of Object.entries(s.scored.summaries ?? {})) {
      for (const [k, v] of Object.entries(sum)) {
        summaryCols.add(`${id}.${k}`);
        r[`${id}.${k}`] = v;
      }
    }
    for (const m of measureNames) r[m] = s.scored.measures[m];
    for (const ex of spec.exclusions) {
      const v = s.scored.exclusions[ex.id];
      r[`excl_${ex.id}`] = v === "missing" ? true : v;
    }
    r.excluded = s.scored.excluded;
    return r;
  });
  const header = [
    "session_id",
    "condition",
    ...factors,
    "status",
    ...summaryCols,
    ...measureNames,
    ...spec.exclusions.map((e) => `excl_${e.id}`),
    "excluded",
  ];
  return toCsv(header, rows);
}

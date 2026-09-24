// Pilot checks: small assertions over a set of sessions, declared in the spec
// before the pilot runs.
//
//   count(main) == 200                         every session has 200 main rows
//   mean(main.correct) between 0.64 and 0.78   mean over participants
//   median(main.confidence_levels_used) >= 3
//   mean(accuracy) >= 0.6                      a spec measure
//   median(minutes) between 18 and 32
//   exclusion_rate <= 0.2
import { mean, median } from "./stats.js";

const NUM = "(-?\\d+(?:\\.\\d+)?)";
const AGG = new RegExp(`^\\s*(mean|median|min|max|count)\\(\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\)\\s*(?:between\\s+${NUM}\\s+and\\s+${NUM}|(==|!=|<=|>=|<|>)\\s*${NUM})\\s*$`);
const RATE = new RegExp(`^\\s*(exclusion_rate|n_sessions)\\s*(==|!=|<=|>=|<|>)\\s*${NUM}\\s*$`);

export function parseCheck(expect) {
  let m = AGG.exec(expect);
  if (m) {
    return {
      kind: "agg",
      fn: m[1],
      target: m[2],
      between: m[3] !== undefined ? [Number(m[3]), Number(m[4])] : null,
      op: m[5] ?? null,
      value: m[6] !== undefined ? Number(m[6]) : null,
    };
  }
  m = RATE.exec(expect);
  if (m) return { kind: "rate", target: m[1], op: m[2], value: Number(m[3]) };
  throw new Error(
    `Can't read check "${expect}". Use e.g. "mean(main.correct) between 0.6 and 0.8", "count(main) == 200" or "exclusion_rate <= 0.2".`,
  );
}

const cmp = (a, op, b) =>
  op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : op === ">=" ? a >= b : op === "==" ? a === b : a !== b;

const toNum = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Per-session value of a target:
 *   step id             -> row count
 *   step.col            -> mean of the column (booleans as 0/1), or a block summary
 *   step.confidence_levels_used -> distinct confidence values
 *   minutes             -> session duration
 *   measure name        -> the measure
 */
function sessionValue(target, s) {
  if (target === "minutes") return s.minutes ?? null;
  if (s.measures && target in s.measures) return s.measures[target];
  const [id, col] = target.split(".");
  const rows = s.rows[id];
  if (!col) return rows ? rows.length : 0;
  if (!rows) return null;
  if (col === "confidence_levels_used") return new Set(rows.map((r) => r.confidence).filter((c) => c != null)).size;
  if (s.summaries?.[id] && col in s.summaries[id]) return toNum(s.summaries[id][col]);
  const vals = rows.map((r) => toNum(r[col])).filter((v) => v !== null);
  return vals.length ? mean(vals) : null;
}

/**
 * Runs checks over scored sessions: [{ rows, measures, summaries, excluded, minutes }].
 * Returns [{ id, level, pass, observed, expect, why }].
 */
export function runChecks(checks, sessions) {
  return checks.map((c) => {
    let pass = false;
    let observed = null;
    try {
      const p = parseCheck(c.expect);
      if (p.kind === "rate") {
        observed =
          p.target === "n_sessions" ? sessions.length : sessions.length ? sessions.filter((s) => s.excluded).length / sessions.length : null;
        pass = observed !== null && cmp(observed, p.op, p.value);
      } else if (p.fn === "count") {
        // Must hold for every session.
        const counts = sessions.map((s) => sessionValue(p.target, s));
        observed = counts.length ? { min: Math.min(...counts), max: Math.max(...counts) } : null;
        pass =
          counts.length > 0 &&
          counts.every((v) => (p.between ? v >= p.between[0] && v <= p.between[1] : cmp(v, p.op, p.value)));
      } else {
        const vals = sessions.map((s) => sessionValue(p.target, s)).filter((v) => v !== null);
        observed = !vals.length
          ? null
          : p.fn === "mean"
            ? mean(vals)
            : p.fn === "median"
              ? median(vals)
              : p.fn === "min"
                ? Math.min(...vals)
                : Math.max(...vals);
        pass = observed !== null && (p.between ? observed >= p.between[0] && observed <= p.between[1] : cmp(observed, p.op, p.value));
      }
    } catch (e) {
      return { ...c, pass: false, observed: null, error: e.message };
    }
    return { ...c, pass, observed: typeof observed === "number" ? Math.round(observed * 1000) / 1000 : observed };
  });
}

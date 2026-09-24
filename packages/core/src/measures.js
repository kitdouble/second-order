// Per-participant measures and exclusions, computed from trial rows exactly as
// the spec declares them. The generated R script mirrors this file.
import { getBlock, blockColumns } from "./blocks/index.js";
import { stepId } from "./compile.js";
import { resolveCond } from "./conditions.js";
import { evalExpr } from "./expr.js";
import { mean, sd, median } from "./stats.js";
import { typeOne, metaDFromTrials } from "./metad.js";

const WHERE = /^\s*(==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)\s*$/;

function whereFn(where) {
  if (!where) return () => true;
  const m = WHERE.exec(where);
  if (!m) throw new Error(`Bad where "${where}". Use e.g. "< 200".`);
  const v = Number(m[2]);
  const op = m[1];
  return (x) =>
    typeof x === "number" &&
    (op === "<" ? x < v : op === "<=" ? x <= v : op === ">" ? x > v : op === ">=" ? x >= v : op === "==" ? x === v : x !== v);
}

const toNum = (v) => (typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" && Number.isFinite(v) ? v : null);

/** Resolved params of a step for a participant's condition (needed for scales etc.). */
function stepParams(spec, id, levels) {
  const item = spec.sequence.find((s) => stepId(s) === id);
  const block = getBlock(spec.blocks[item.use]);
  return { block, params: block.params.parse(resolveCond(item.params ?? {}, levels)) };
}

/**
 * Computes one measure for one participant.
 * participant: { levels, rows: { [stepId]: [row, ...] } }
 */
/** Applies a measure's row filter (an expression over the step's columns). */
function filterRows(spec, stepIdName, rows, filter, levels = {}) {
  if (!filter) return rows;
  const item = spec.sequence.find((s) => stepId(s) === stepIdName);
  let cols = [];
  if (item) {
    const block = getBlock(spec.blocks[item.use]);
    let parsed = null;
    try {
      parsed = block?.params.safeParse(resolveCond(item.params ?? {}, levels));
    } catch {
      parsed = null; // unresolvable condition: fall back to the block's fixed columns
    }
    cols = Object.keys(blockColumns(block, parsed?.success ? parsed.data : null));
  }
  const blank = Object.fromEntries(cols.map((c) => [c, null]));
  return rows.filter((r) => {
    try {
      return evalExpr(filter, { ...blank, ...r });
    } catch {
      return false;
    }
  });
}

export function computeMeasure(spec, m, participant) {
  if (m.fn === "diff") throw new Error("diff measures are computed after the others.");
  if (["d_prime", "meta_d", "mratio"].includes(m.fn)) {
    const rows = filterRows(spec, m.from, participant.rows[m.from] ?? [], m.filter, participant.levels);
    if (!rows.length) return null;
    if (m.fn === "d_prime") return typeOne(rows)?.d_prime ?? null;
    const { params } = stepParams(spec, m.from, participant.levels);
    if (!params.confidence) return null;
    const fit = metaDFromTrials(rows, params.confidence.scale);
    if (!fit) return null;
    return m.fn === "meta_d" ? fit.meta_d : fit.mratio;
  }
  const [id, col] = (m.of ?? "").split(".");
  const rows = filterRows(spec, id, participant.rows[id] ?? [], m.filter, participant.levels);
  if (m.fn === "count") return col ? rows.filter((r) => r[col] !== null && r[col] !== undefined).length : rows.length;
  if (m.fn === "first") {
    const summary = participant.summaries?.[id]?.[col];
    if (summary !== undefined) return summary;
    return rows[0]?.[col] ?? null;
  }
  const vals = rows.map((r) => toNum(r[col])).filter((v) => v !== null);
  if (m.fn === "prop") {
    if (!vals.length) return null;
    return vals.filter(whereFn(m.where)).length / vals.length;
  }
  const kept = vals.filter(whereFn(m.where));
  if (m.fn === "mean") return mean(kept);
  if (m.fn === "sd") return sd(kept);
  if (m.fn === "median") return median(kept);
  throw new Error(`Unknown measure fn ${m.fn}.`);
}

/** Block summaries (e.g. attn.passed, ius.score) for one participant. */
export function summaries(spec, participant) {
  const out = {};
  for (const item of spec.sequence) {
    const id = stepId(item);
    const block = getBlock(spec.blocks[item.use]);
    if (!block.summarize) continue;
    const { params } = stepParams(spec, id, participant.levels);
    out[id] = block.summarize(participant.rows[id] ?? [], params);
  }
  return out;
}

/** Values available to exclusion expressions: measures plus "<step>.<summary>". */
export function expressionValues(measures, sums) {
  const vals = { ...measures };
  for (const [id, s] of Object.entries(sums)) for (const [k, v] of Object.entries(s)) vals[`${id}.${k}`] = v;
  return vals;
}

/**
 * Full participant scoring: measures, summaries and exclusions.
 * Exclusions are flags, never deletions. A participant with a missing value in
 * an exclusion rule is flagged `missing` for that rule and treated as excluded.
 */
export function scoreParticipant(spec, participant) {
  participant.summaries = summaries(spec, participant);
  const measures = {};
  for (const [name, m] of Object.entries(spec.measures ?? {})) {
    if (m.fn === "diff") continue;
    try {
      measures[name] = computeMeasure(spec, m, participant);
    } catch {
      measures[name] = null;
    }
  }
  // Differences between measures, e.g. a congruency effect.
  for (const [name, m] of Object.entries(spec.measures ?? {})) {
    if (m.fn !== "diff") continue;
    const a = measures[m.a];
    const b = measures[m.b];
    measures[name] = typeof a === "number" && typeof b === "number" && Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
  }
  const values = expressionValues(measures, participant.summaries);
  const exclusions = {};
  for (const ex of spec.exclusions ?? []) {
    const ids = ex.when.match(/[A-Za-z_][A-Za-z0-9_.]*/g) ?? [];
    const missing = ids.some(
      (i) => !["and", "or", "not", "true", "false", "null"].includes(i) && (values[i] === null || values[i] === undefined),
    );
    exclusions[ex.id] = missing ? "missing" : evalExpr(ex.when, values);
  }
  const excluded = Object.values(exclusions).some((v) => v === true || v === "missing");
  return { measures, summaries: participant.summaries, exclusions, excluded };
}

// Deterministic QA: plays one synthetic participant through every condition
// and checks the data that comes out. Catches broken references, missing
// columns, wrong trial counts and conditions that don't differ as intended.
// (Screenshot-based checks of the real browser bundle run separately.)
import { getBlock } from "./blocks/index.js";
import { listConditions, resolveCond, findConds } from "./conditions.js";
import { simulateSession, drawObserver } from "./simulate.js";
import { scoreParticipant } from "./measures.js";
import { estimateMinutes } from "./estimate.js";
import { runChecks } from "./checks.js";
import { stepId } from "./compile.js";
import { makeRng } from "./rng.js";

const TYPE_OK = {
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
};

export function runQa(spec, { seed = "qa" } = {}) {
  const findings = [];
  const add = (severity, message, where = null) => findings.push({ severity, message, where });
  const conditions = listConditions(spec);
  const report = [];

  for (const cond of conditions) {
    const obs = drawObserver(spec.simulation?.truth, cond.levels, makeRng(`${seed}:${cond.key}`));
    obs.attentionPass = 1; // QA participant is always attentive
    let result;
    try {
      result = simulateSession(spec, cond.levels, `${seed}:${cond.key}`, obs);
    } catch (e) {
      add("blocker", `Condition ${cond.key} fails to run: ${e.message}`);
      continue;
    }
    const { plan, rows } = result;
    const steps = [];
    for (const step of plan.steps) {
      const block = getBlock(step.block);
      const got = rows[step.id] ?? [];
      const expected = step.params.record === false ? 0 : step.items.length;
      if (got.length !== expected) {
        add("blocker", `${cond.key}: step "${step.id}" produced ${got.length} rows, expected ${expected}.`, step.id);
      }
      for (const [col, type] of Object.entries(block.columns)) {
        const bad = got.filter((r) => r[col] !== null && r[col] !== undefined && !TYPE_OK[type](r[col]));
        if (bad.length) add("blocker", `${cond.key}: column ${step.id}.${col} has ${bad.length} values that are not ${type}.`, step.id);
      }
      steps.push({
        id: step.id,
        block: step.block,
        rows: got.length,
        recorded: step.params.record !== false,
        key_params: keyParams(step),
      });
    }
    const participant = { levels: cond.levels, rows };
    const scored = scoreParticipant(spec, participant);
    for (const [name, v] of Object.entries(scored.measures)) {
      if (v === null || v === undefined || Number.isNaN(v)) add("blocker", `${cond.key}: measure "${name}" could not be computed.`, `measures.${name}`);
    }
    for (const [id, v] of Object.entries(scored.exclusions)) {
      if (v === true) add("warning", `${cond.key}: an attentive synthetic participant was excluded by "${id}". Check the threshold.`, `exclusions`);
      if (v === "missing") add("blocker", `${cond.key}: exclusion "${id}" refers to a value that is missing.`, `exclusions`);
    }
    report.push({ condition: cond.key, steps, measures: round(scored.measures), excluded: scored.excluded });
  }

  // Conditions should actually differ where the spec says they do.
  if (conditions.length > 1) {
    spec.sequence.forEach((item) => {
      for (const { path, node } of findConds(item.params ?? {})) {
        const values = conditions.map((c) => JSON.stringify(resolveCond(node, c.levels)));
        if (new Set(values).size === 1) {
          add("warning", `$cond at ${stepId(item)}.${path.join(".")} gives the same value in every condition.`, stepId(item));
        }
      }
    });
    const anyCond = spec.sequence.some((i) => findConds(i.params ?? {}).length > 0);
    if (!anyCond) add("blocker", "There are several conditions but no $cond, so every condition sees the same study.");
  }

  // Pilot checks against the synthetic sessions (should pass for a sane design).
  if (spec.pilot?.checks?.length) {
    const sessions = report.length
      ? conditions.map((cond) => {
          const obs = drawObserver(spec.simulation?.truth, cond.levels, makeRng(`${seed}:pc:${cond.key}`));
          const { rows } = simulateSession(spec, cond.levels, `${seed}:pc:${cond.key}`, obs);
          const p = { levels: cond.levels, rows };
          const s = scoreParticipant(spec, p);
          return { rows, ...s, minutes: estimateMinutes(spec) };
        })
      : [];
    for (const r of runChecks(spec.pilot.checks, sessions)) {
      if (!r.pass) add("warning", `Pilot check "${r.id}" fails even on synthetic data (observed ${JSON.stringify(r.observed)}). The threshold may be wrong.`, `pilot.checks`);
    }
  }

  return {
    ok: !findings.some((f) => f.severity === "blocker"),
    conditions: report,
    est_minutes: Math.round(estimateMinutes(spec) * 10) / 10,
    findings,
    not_checked: [
      "What the screens look like (layout, clipping on phones, contrast). Use the preview links.",
      "Whether the instructions match the task. The AI review and your click-through cover this.",
      "Real-browser timing.",
    ],
  };
}

function keyParams(step) {
  const p = step.params;
  const out = {};
  for (const k of ["feedback", "trials", "blocks", "trials_per_block", "record", "correct"]) if (k in p) out[k] = p[k];
  if (p.staircase) out.staircase = p.staircase;
  if (p.confidence !== undefined) out.confidence = p.confidence ? p.confidence.scale : false;
  if (p.keys) out.keys = p.keys;
  return out;
}

function round(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "number" ? Math.round(v * 1000) / 1000 : v]));
}

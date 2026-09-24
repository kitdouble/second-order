// Semantic validation on top of the schema: references resolve, parameters are
// valid in every condition, expressions only use names that exist.
// Errors block review; warnings are shown to the reviewer.
import { parseSpec, formatIssues } from "./schema.js";
import { getBlock } from "./blocks/index.js";
import { listConditions, resolveCond, findConds } from "./conditions.js";
import { stepId } from "./compile.js";
import { parseExpr, exprIdentifiers } from "./expr.js";
import { parseCheck } from "./checks.js";
import { estimateMinutes } from "./estimate.js";

const PROLIFIC_MIN_HOURLY = { GBP: 6, USD: 8 };
const PROLIFIC_RECOMMENDED_HOURLY = { GBP: 9, USD: 12 };

export function validateSpec(input) {
  const parsed = parseSpec(input);
  if (!parsed.ok) return { ok: false, spec: null, errors: parsed.errors, warnings: [] };
  const spec = parsed.spec;
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  // Blocks exist.
  for (const [alias, ref] of Object.entries(spec.blocks)) {
    if (!getBlock(ref)) err(`blocks.${alias}`, `No block "${ref}". Call get with kind "block_catalog" to see what exists.`);
  }

  const conditions = listConditions(spec);
  const factors = spec.design.between;

  // Sequence.
  const seen = new Map(); // id -> { block, index }
  spec.sequence.forEach((item, i) => {
    const path = `sequence.${i}`;
    const ref = spec.blocks[item.use];
    if (!ref) return err(`${path}.use`, `"${item.use}" is not declared under blocks.`);
    const block = getBlock(ref);
    if (!block) return;
    const id = stepId(item);
    if (seen.has(id)) err(`${path}.id`, `Step id "${id}" is used twice. Give one of them an id.`);

    for (const { path: p, node } of findConds(item.params ?? {})) {
      const f = node.$cond;
      const where = `${path}.params.${p.join(".")}`;
      if (!factors[f]) {
        err(where, `$cond refers to "${f}", which is not a between-subjects factor.`);
        continue;
      }
      for (const k of Object.keys(node)) {
        if (k !== "$cond" && k !== "default" && !factors[f].includes(k)) err(where, `"${k}" is not a level of ${f}.`);
      }
      const missing = factors[f].filter((l) => !(l in node));
      if (missing.length && !("default" in node)) err(where, `$cond has no value for ${f}=${missing.join(", ")} and no default.`);
    }

    for (const c of conditions) {
      let resolved;
      try {
        resolved = resolveCond(item.params ?? {}, c.levels);
      } catch (e) {
        continue; // reported above
      }
      const r = block.params.safeParse(resolved);
      if (!r.success) {
        for (const issue of formatIssues(r.error.issues)) {
          err(`${path}.params.${issue.path}`, `${issue.message}${conditions.length > 1 ? ` (in ${c.key})` : ""}`);
        }
        continue;
      }
      const p = r.data;
      if (block.ref.startsWith("dots") && p.staircase && "continue_from" in p.staircase) {
        const src = seen.get(p.staircase.continue_from);
        if (!src || !src.block.startsWith("dots")) {
          err(`${path}.params.staircase.continue_from`, `continue_from must name an earlier dots step.`);
        }
      }
      if (block.ref.startsWith("attention") && !p.options.includes(p.correct)) {
        err(`${path}.params.correct`, `"${p.correct}" is not one of the options.`);
      }
      if (block.ref.startsWith("dots") && p.keys.left === p.keys.right) {
        err(`${path}.params.keys`, "Left and right keys must differ.");
      }
    }
    seen.set(id, { block: ref, index: i, item });
  });

  // Measures.
  const summaryIds = new Set();
  for (const [id, info] of seen) {
    for (const k of getBlock(info.block)?.summaryKeys ?? []) summaryIds.add(`${id}.${k}`);
  }
  for (const [name, m] of Object.entries(spec.measures)) {
    const path = `measures.${name}`;
    if (["d_prime", "meta_d", "mratio"].includes(m.fn)) {
      const src = m.from && seen.get(m.from);
      if (!src) {
        err(path, `${m.fn} needs "from: <step id>" naming a task step.`);
        continue;
      }
      const block = getBlock(src.block);
      if (!block?.sdt) err(path, `Step "${m.from}" does not support SDT measures.`);
      if (m.fn !== "d_prime") {
        for (const c of conditions) {
          const p = block.params.safeParse(resolveCond(src.item.params ?? {}, c.levels));
          if (p.success && !p.data.confidence) err(path, `${m.fn} needs confidence ratings in "${m.from}" (off in ${c.key}).`);
        }
      }
      continue;
    }
    if (!m.of) {
      err(path, `${m.fn} needs "of: <step>.<column>" (or just "<step>" for count).`);
      continue;
    }
    const [id, col] = m.of.split(".");
    const src = seen.get(id);
    if (!src) {
      err(`${path}.of`, `No step "${id}".`);
      continue;
    }
    const block = getBlock(src.block);
    if (col && !(col in block.columns) && !(block.summaryKeys ?? []).includes(col)) {
      err(`${path}.of`, `"${block.ref}" has no column "${col}". Columns: ${Object.keys(block.columns).join(", ")}.`);
    }
    if (!col && m.fn !== "count") err(`${path}.of`, `Name a column, e.g. "${id}.${Object.keys(block.columns)[0]}".`);
    if (m.where && !/^\s*(==|!=|<=|>=|<|>)\s*-?\d+(\.\d+)?\s*$/.test(m.where)) err(`${path}.where`, `Use a comparison like "< 200".`);
  }

  // Exclusions.
  const exprNames = new Set([...Object.keys(spec.measures), ...summaryIds]);
  const exIds = new Set();
  spec.exclusions.forEach((ex, i) => {
    const path = `exclusions.${i}`;
    if (exIds.has(ex.id)) err(`${path}.id`, `Exclusion id "${ex.id}" is used twice.`);
    exIds.add(ex.id);
    try {
      parseExpr(ex.when);
      for (const n of exprIdentifiers(ex.when)) {
        if (!exprNames.has(n)) err(`${path}.when`, `"${n}" is not a measure or block value. Available: ${[...exprNames].join(", ") || "none"}.`);
      }
    } catch (e) {
      err(`${path}.when`, e.message);
    }
  });

  // Analysis.
  const primary = spec.analysis.primary;
  const factorNames = Object.keys(factors);
  if (primary) {
    if (!(primary.dv in spec.measures)) err("analysis.primary.dv", `"${primary.dv}" is not a declared measure.`);
    const factor = primary.factor ?? (factorNames.length === 1 ? factorNames[0] : null);
    if (!factor || !factors[factor]) err("analysis.primary.factor", "Name the between-subjects factor to compare.");
    else if (factors[factor].length !== 2) err("analysis.primary.factor", `An independent t-test needs exactly 2 levels; ${factor} has ${factors[factor].length}.`);
    else if (primary.prior?.direction) {
      const m = /^\s*([a-z][a-z0-9_]*)\s*>\s*([a-z][a-z0-9_]*)\s*$/.exec(primary.prior.direction);
      if (!m || !factors[factor].includes(m[1]) || !factors[factor].includes(m[2]) || m[1] === m[2]) {
        err("analysis.primary.prior.direction", `Write the direction as "<level> > <level>" using ${factors[factor].join(", ")}.`);
      }
    }
  }
  const stop = spec.analysis.stopping;
  if (stop) {
    if (!primary) err("analysis.stopping", "A stopping rule needs a primary analysis.");
    try {
      parseExpr(stop.stop_when);
      for (const n of exprIdentifiers(stop.stop_when)) {
        if (!["bf10", "n_min", "n_total"].includes(n)) err("analysis.stopping.stop_when", `"${n}" is not available. Use bf10, n_min or n_total.`);
      }
    } catch (e) {
      err("analysis.stopping.stop_when", e.message);
    }
    if (stop.min_n_per_group > stop.max_n_per_group) err("analysis.stopping", "min_n_per_group is larger than max_n_per_group.");
    const groups = primary?.factor ? factors[primary.factor]?.length ?? 2 : 2;
    if (stop.max_n_per_group * groups > spec.recruitment.max_n) {
      warn("recruitment.max_n", `max_n (${spec.recruitment.max_n}) is below what the stopping rule allows before exclusions (${stop.max_n_per_group * groups}).`);
    }
  }

  // Pilot checks.
  (spec.pilot?.checks ?? []).forEach((c, i) => {
    try {
      const p = parseCheck(c.expect);
      if (p.kind === "agg") {
        const [id, col] = p.target.split(".");
        const ok =
          p.target === "minutes" ||
          p.target in spec.measures ||
          (seen.has(id) && (!col || col === "confidence_levels_used" || col in getBlock(seen.get(id).block).columns || summaryIds.has(p.target)));
        if (!ok) err(`pilot.checks.${i}.expect`, `"${p.target}" is not a step, column, or measure.`);
      }
    } catch (e) {
      err(`pilot.checks.${i}.expect`, e.message);
    }
  });

  // Warnings a reviewer should see.
  const firstRef = spec.blocks[spec.sequence[0].use] ?? "";
  if (!firstRef.startsWith("consent")) warn("sequence.0", "The study does not start with consent.");
  const lastRef = spec.blocks[spec.sequence.at(-1).use] ?? "";
  if (!lastRef.startsWith("debrief")) warn("sequence", "The study does not end with a debrief.");
  if (![...seen.values()].some((s) => s.block.startsWith("attention"))) warn("sequence", "No attention check.");

  if (errors.length === 0) {
    const est = estimateMinutes(spec);
    const stated = spec.recruitment.est_minutes;
    if (Math.abs(est - stated) / stated > 0.3) {
      warn("recruitment.est_minutes", `Stated ${stated} min, but the blocks add up to about ${Math.round(est)} min.`);
    }
    const reward = spec.recruitment.reward_per_participant;
    const cur = spec.recruitment.currency;
    if (reward !== undefined && PROLIFIC_MIN_HOURLY[cur]) {
      const hourly = (reward / Math.max(stated, est)) * 60;
      if (hourly < PROLIFIC_MIN_HOURLY[cur]) {
        err("recruitment.reward_per_participant", `About ${cur} ${hourly.toFixed(2)}/hour, below Prolific's minimum of ${PROLIFIC_MIN_HOURLY[cur]}/hour.`);
      } else if (hourly < PROLIFIC_RECOMMENDED_HOURLY[cur]) {
        warn("recruitment.reward_per_participant", `About ${cur} ${hourly.toFixed(2)}/hour, below Prolific's recommended ${PROLIFIC_RECOMMENDED_HOURLY[cur]}/hour.`);
      }
    }
  }

  return { ok: errors.length === 0, spec, errors, warnings };
}

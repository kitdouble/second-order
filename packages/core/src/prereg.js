// Preregistration and methods text generated from the spec, so the prereg and
// what runs can't drift apart. Output is a draft for the researcher to edit.
import { getBlock } from "./blocks/index.js";
import { listConditions, resolveCond } from "./conditions.js";
import { stepId } from "./compile.js";
import { estimateMinutes } from "./estimate.js";
import { primaryGroups } from "./simulate.js";
import { textToPlain } from "./text.js";

export function generatePrereg(spec, { hash = "draft", simulation = null } = {}) {
  const conds = listConditions(spec);
  const factors = spec.design.between;
  const L = [];
  L.push(`# Preregistration: ${spec.study.title}`);
  L.push(``);
  L.push(`Generated from study spec \`${hash}\`. Any later change to the design, measures, exclusions, sample size or analysis will show as a deviation from this hash.`);
  L.push(``);
  L.push(`## Hypothesis`);
  L.push(``);
  L.push(spec.analysis.primary ? spec.analysis.primary.hypothesis : "_No primary hypothesis declared._");
  L.push(``);
  L.push(`## Design`);
  L.push(``);
  if (Object.keys(factors).length) {
    L.push(
      `Between-subjects design with ${Object.entries(factors)
        .map(([f, ls]) => `${f} (${ls.join(" vs ")})`)
        .join(" × ")}: ${conds.length} conditions. Participants are assigned at random, weighted towards conditions that are furthest from their target sample, so group sizes stay close.`,
    );
  } else L.push(`Single-condition design.`);
  L.push(``);
  L.push(`## Procedure`);
  L.push(``);
  L.push(`The study takes about ${Math.round(estimateMinutes(spec))} minutes and runs in the participant's web browser (jsPsych).`);
  L.push(``);
  spec.sequence.forEach((item, i) => {
    const block = getBlock(spec.blocks[item.use]);
    const p = block.params.parse(resolveCond(item.params ?? {}, conds[0].levels));
    L.push(`${i + 1}. **${block.title}** (\`${stepId(item)}\`)${describeStep(block, p, item, conds)}`);
  });
  L.push(``);
  L.push(`## Measures`);
  L.push(``);
  for (const [name, m] of Object.entries(spec.measures)) L.push(`- **${name}**: ${describeMeasure(m)}`);
  L.push(``);
  L.push(`## Exclusions`);
  L.push(``);
  if (!spec.exclusions.length) L.push(`No exclusion criteria.`);
  for (const ex of spec.exclusions) L.push(`- \`${ex.id}\`: exclude if ${ex.when}${ex.note ? ` (${ex.note})` : ""}.`);
  if (spec.exclusions.length) L.push(`\nParticipants with a missing value for any criterion are excluded. Exclusions are applied before analysis and before stopping-rule checks.`);
  L.push(``);
  L.push(`## Sample size and stopping`);
  L.push(``);
  const st = spec.analysis.stopping;
  if (st) {
    L.push(
      `Sequential Bayesian design. After every ${st.check_every} included participants, once each group has at least ${st.min_n_per_group}, the primary Bayes factor is computed. Data collection stops when ${st.stop_when}, or when each group reaches ${st.max_n_per_group} included participants. At most ${spec.recruitment.max_n} participants will be recruited in total. Stopping checks are computed automatically by the platform and logged.`,
    );
  } else L.push(`Up to ${spec.recruitment.max_n} participants.`);
  L.push(``);
  L.push(`## Analysis`);
  L.push(``);
  const g = primaryGroups(spec);
  if (g) {
    const pr = spec.analysis.primary;
    L.push(
      `Independent-samples Bayesian t-test (JZS, Cauchy prior on effect size with scale r = ${pr.prior?.cauchy_r ?? 0.707}) comparing ${pr.dv} between ${g.factor} = ${g.x} and ${g.factor} = ${g.y}${g.directional ? `, directional (${g.x} > ${g.y})` : ", two-sided"}. Computed with BayesFactor::ttestBF in R; the analysis script is generated from this spec and was tested on simulated data before collection.`,
    );
  }
  for (const s of spec.analysis.secondary) L.push(`\n- Secondary: ${s}`);
  if (simulation?.sequential) {
    L.push(``);
    L.push(`## Design analysis (simulation)`);
    L.push(``);
    L.push(
      `In ${simulation.reps_done} simulated studies, the design stopped for H1 in ${simulation.sequential.pct_stop_for_h1}% and for H0 in ${simulation.sequential.pct_stop_for_h0}% of runs, reaching the maximum in ${simulation.sequential.pct_reach_max}%, with a mean of ${simulation.sequential.mean_included_n_at_stop} included participants at stopping.`,
    );
  }
  L.push(``);
  return L.join("\n");
}

function describeStep(block, p, item, conds) {
  if (block.sdt) {
    const total = (p.trials_per_block ?? p.trials ?? 50) * p.blocks;
    const fb = conds.length > 1 && JSON.stringify(item.params?.feedback ?? "").includes("$cond")
      ? `; feedback: ${conds.map((c) => `${c.key} → ${resolveCond(item.params.feedback, c.levels)}`).join(", ")}`
      : `; feedback: ${p.feedback}`;
    const sc = "continue_from" in p.staircase ? `staircase continued from ${p.staircase.continue_from}` : "fixed_diff" in p.staircase ? `fixed difficulty ${p.staircase.fixed_diff} dots` : `${p.staircase.rule} staircase starting at ${p.staircase.start_diff} dots`;
    const conf = p.confidence ? `; confidence ${p.confidence.scale[0]}-${p.confidence.scale[1]} (${p.confidence.labels.join(" to ")})` : "";
    return `: ${total} trials in ${p.blocks} block(s), ${p.base_dots} base dots, ${p.stim_ms} ms presentation, ${sc}${fb}${conf}${p.record === false ? ". Practice, not analysed." : "."}`;
  }
  if (block.ref.startsWith("likert")) return `: ${p.instrument ?? "questionnaire"}, ${p.items.length} items, ${p.scale.min}-${p.scale.max} scale.`;
  if (block.custom) return `: custom jsPsych code. ${textToPlain(p.description)} Records ${p.expected_rows} row(s) with columns ${Object.keys(p.columns).join(", ")}. The code is part of the versioned spec.`;
  if (block.ref.startsWith("choice-rt")) {
    const total = (p.trials_per_block ?? p.trials ?? p.stimuli.reduce((a, x) => a + x.weight, 0)) * p.blocks;
    const types = [...new Set(p.stimuli.map((x) => x.type))];
    return `: ${total} trials in ${p.blocks} block(s); ${p.stimuli.length} stimuli (${types.join(", ")}); responses ${p.responses
      .map((r) => `${r.name} = ${r.key.toUpperCase()}`)
      .join(", ")}; ${p.response_window_ms ? `${p.response_window_ms} ms response window` : "no time limit"}; feedback ${p.feedback}${
      p.record === false ? ". Practice, not analysed." : "."
    }`;
  }
  if (block.ref.startsWith("attention")) return `: "${textToPlain(p.item)}" (correct: ${p.correct}).`;
  return ".";
}

function describeMeasure(m) {
  if (m.fn === "diff") return `${m.a} minus ${m.b}`;
  const base = describeMeasureBase(m);
  return m.filter ? `${base}, trials where ${m.filter}` : base;
}

function describeMeasureBase(m) {
  const map = {
    mean: `mean of ${m.of}`,
    sd: `standard deviation of ${m.of}`,
    median: `median of ${m.of}`,
    prop: `proportion of ${m.of} values ${m.where ?? ""}`,
    count: `number of ${m.of} rows`,
    first: `${m.of}`,
    d_prime: `type 1 d' from ${m.from}`,
    meta_d: `meta-d' (maximum likelihood, Maniscalco & Lau, 2012) from ${m.from}`,
    mratio: `M-ratio (meta-d'/d', maximum likelihood, Maniscalco & Lau, 2012) from ${m.from}`,
  };
  const base = map[m.fn];
  return m.where && m.fn !== "prop" ? `${base}, trials with values ${m.where}` : base;
}

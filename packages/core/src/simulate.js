// Synthetic participants. Explicit generative models (not LLM personas): an SDT
// observer with a known meta-d'/d' ratio, run through the compiled study plan
// with the same staircase code the browser uses.
import { getBlock } from "./blocks/index.js";
import { compile } from "./compile.js";
import { listConditions } from "./conditions.js";
import { createStaircase } from "./staircase.js";
import { makeRng } from "./rng.js";
import { scoreParticipant } from "./measures.js";
import { bfTTestIndependent, mean, sd } from "./stats.js";
import { evalExpr } from "./expr.js";

const DEFAULT_TRUTH = {
  threshold: { mean: 12, sd: 4 },
  mratio: { mean: 0.8, sd: 0.25 },
  attention_pass: 0.95,
};

/** Draws one simulated participant's parameters for a condition. */
export function drawObserver(truth, levels, rng) {
  const t = { ...DEFAULT_TRUTH, ...(truth ?? {}) };
  let mrMean = t.mratio?.mean ?? 0.8;
  for (const [factor, byLevel] of Object.entries(t.mratio?.by ?? {})) {
    if (levels[factor] !== undefined && byLevel[levels[factor]] !== undefined) mrMean = byLevel[levels[factor]];
  }
  return {
    threshold: Math.max(2, rng.normal(t.threshold?.mean ?? 12, t.threshold?.sd ?? 4)),
    mratio: Math.max(0.05, rng.normal(mrMean, t.mratio?.sd ?? 0.25)),
    trueMratioMean: mrMean,
    bias: rng.normal(0, 0.2),
    confSpacing: Math.exp(rng.normal(Math.log(0.5), 0.25)),
    rtMedian: Math.exp(rng.normal(Math.log(700), 0.2)),
    attentionPass: t.attention_pass ?? 0.95,
    trait: rng.normal(0, 1),
  };
}

/** Runs one synthetic session through the plan. Returns rows keyed by step id. */
export function simulateSession(spec, levels, seed, observer) {
  const plan = compile(spec, levels, seed);
  const rng = makeRng(`sim:${seed}`);
  const rows = {};
  const stairs = {};
  for (const step of plan.steps) {
    const block = getBlock(step.block);
    let stair = null;
    if (step.params.staircase) {
      const sc = step.params.staircase;
      if ("continue_from" in sc) stair = createStaircase({}, stairs[sc.continue_from]?.snapshot());
      else if ("fixed_diff" in sc) stair = createStaircase({ start_diff: sc.fixed_diff, step: [0] });
      else stair = createStaircase(sc);
      stairs[step.id] = stair;
    }
    const out = block.simulate(step.params, step.items, observer, rng, stair);
    // Unrecorded steps (e.g. practice) still run but keep no rows, like the runtime.
    rows[step.id] = step.params.record === false ? [] : out;
  }
  return { plan, rows };
}

/** Condition levels for the primary comparison: [higher, lower] if directional. */
export function primaryGroups(spec) {
  const pr = spec.analysis.primary;
  if (!pr) return null;
  const factor = pr.factor ?? Object.keys(spec.design.between)[0];
  const levels = spec.design.between[factor];
  const m = /^\s*(\w+)\s*>\s*(\w+)\s*$/.exec(pr.prior?.direction ?? "");
  return { factor, x: m ? m[1] : levels[0], y: m ? m[2] : levels[1], directional: Boolean(m) };
}

/**
 * Bayes factor for the primary analysis over a set of scored participants.
 * participants: [{ levels, scored: { measures, excluded } }]
 */
export function primaryTest(spec, participants) {
  const g = primaryGroups(spec);
  if (!g) return null;
  const dv = spec.analysis.primary.dv;
  const pick = (lvl) =>
    participants
      .filter((p) => p.levels[g.factor] === lvl && !p.scored.excluded)
      .map((p) => p.scored.measures[dv])
      .filter((v) => typeof v === "number" && Number.isFinite(v));
  const x = pick(g.x);
  const y = pick(g.y);
  const res = bfTTestIndependent(x, y, { r: spec.analysis.primary.prior?.cauchy_r ?? 0.707, directional: g.directional });
  return { groups: g, n_x: x.length, n_y: y.length, ...(res ?? { bf10: null }) };
}

/** Evaluates the stopping rule for included participants. */
export function stoppingDecision(spec, test) {
  const stop = spec.analysis.stopping;
  if (!stop || !test) return { decision: "continue", reason: "No stopping rule." };
  const nMin = Math.min(test.n_x, test.n_y);
  const nTotal = test.n_x + test.n_y;
  if (nMin >= stop.max_n_per_group) return { decision: "stop_max", reason: `Reached ${stop.max_n_per_group} per group.` };
  if (nMin < stop.min_n_per_group) return { decision: "continue", reason: `Below ${stop.min_n_per_group} per group.` };
  if (test.bf10 === null || test.bf10 === undefined) return { decision: "continue", reason: "BF not computable yet." };
  const hit = evalExpr(stop.stop_when, { bf10: test.bf10, n_min: nMin, n_total: nTotal });
  if (!hit) return { decision: "continue", reason: `BF10 = ${test.bf10.toFixed(2)}; rule not met.` };
  return { decision: test.bf10 >= 1 ? "stop_h1" : "stop_h0", reason: `BF10 = ${test.bf10.toFixed(2)} meets "${stop.stop_when}".` };
}

/**
 * Design analysis: power at fixed Ns and, if a stopping rule exists, the
 * sequential design (expected N and decision rates). Also parameter recovery.
 * Returns partial results if the time budget runs out.
 */
export function runSimulation(spec, { reps, nPerGroup, seed = "sim", budgetMs = 60000 } = {}) {
  const started = Date.now();
  const cfg = spec.simulation ?? {};
  const R = reps ?? cfg.reps ?? 100;
  const Ns = (nPerGroup ?? cfg.n_per_group ?? [30, 60, 100]).slice().sort((a, b) => a - b);
  const g = primaryGroups(spec);
  const conds = listConditions(spec);
  const stop = spec.analysis.stopping;
  const maxN = Math.max(Ns.at(-1), stop?.max_n_per_group ?? 0);

  const fixed = Object.fromEntries(Ns.map((n) => [n, { h1: 0, h0: 0, inconclusive: 0, bfs: [] }]));
  const seq = { h1: 0, h0: 0, max: 0, ns: [] };
  const recovery = [];
  const exclusionRates = [];
  let done = 0;

  for (let r = 0; r < R; r++) {
    if (Date.now() - started > budgetMs) break;
    const rng = makeRng(`${seed}:${r}`);
    // Simulate maxN participants per group (in arrival order), score each once.
    const people = [];
    const groupLevels = g ? [g.x, g.y] : [null];
    for (let i = 0; i < maxN; i++) {
      for (const lvl of groupLevels) {
        const cond = g ? conds.find((c) => c.levels[g.factor] === lvl) : conds[0];
        const obs = drawObserver(cfg.truth, cond.levels, rng);
        const { rows } = simulateSession(spec, cond.levels, `${seed}:${r}:${i}:${lvl}`, obs);
        const p = { levels: cond.levels, rows };
        p.scored = scoreParticipant(spec, p);
        p.obs = obs;
        people.push(p);
        if (r === 0 && spec.analysis.primary?.dv && typeof p.scored.measures[spec.analysis.primary.dv] === "number") {
          recovery.push({ truth: obs.mratio, est: p.scored.measures[spec.analysis.primary.dv], level: lvl });
        }
      }
    }
    exclusionRates.push(people.filter((p) => p.scored.excluded).length / people.length);
    if (!g) {
      done++;
      continue;
    }
    // Fixed-N power. People arrive in order, so the first n per group is a prefix.
    for (const n of Ns) {
      const subset = people.slice(0, n * 2);
      const t = primaryTest(spec, subset);
      const bf = t?.bf10;
      fixed[n].bfs.push(bf);
      if (bf >= 10) fixed[n].h1++;
      else if (bf !== null && bf <= 0.1) fixed[n].h0++;
      else fixed[n].inconclusive++;
    }
    // Sequential design: check after every `check_every` included participants.
    if (stop) {
      let decided = null;
      let lastChecked = 0;
      for (let k = 1; k <= people.length; k++) {
        const included = people.slice(0, k).filter((p) => !p.scored.excluded).length;
        if (included - lastChecked < stop.check_every && k < people.length) continue;
        lastChecked = included;
        const t = primaryTest(spec, people.slice(0, k));
        const d = stoppingDecision(spec, t);
        if (d.decision !== "continue") {
          decided = { ...d, n_total: t.n_x + t.n_y };
          break;
        }
      }
      if (!decided) decided = { decision: "stop_max", n_total: people.filter((p) => !p.scored.excluded).length };
      if (decided.decision === "stop_h1") seq.h1++;
      else if (decided.decision === "stop_h0") seq.h0++;
      else seq.max++;
      seq.ns.push(decided.n_total);
    }
    done++;
  }

  const pct = (x) => (done ? Math.round((100 * x) / done) : null);
  const corr = (pairs) => {
    if (pairs.length < 3) return null;
    const a = pairs.map((p) => p.truth);
    const b = pairs.map((p) => p.est);
    const ma = mean(a);
    const mb = mean(b);
    const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (a.length - 1);
    return cov / (sd(a) * sd(b));
  };
  return {
    reps_requested: R,
    reps_done: done,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    truncated: done < R,
    exclusion_rate: exclusionRates.length ? Math.round(mean(exclusionRates) * 1000) / 1000 : null,
    fixed_n: Ns.map((n) => ({
      n_per_group_before_exclusions: n,
      pct_bf_over_10: pct(fixed[n].h1),
      pct_bf_under_0_1: pct(fixed[n].h0),
      pct_inconclusive: pct(fixed[n].inconclusive),
    })),
    sequential: stop
      ? {
          pct_stop_for_h1: pct(seq.h1),
          pct_stop_for_h0: pct(seq.h0),
          pct_reach_max: pct(seq.max),
          mean_included_n_at_stop: seq.ns.length ? Math.round(mean(seq.ns)) : null,
        }
      : null,
    parameter_recovery: recovery.length
      ? {
          n: recovery.length,
          correlation_true_vs_estimated: Math.round(corr(recovery) * 1000) / 1000,
          mean_estimate_by_level: Object.fromEntries(
            [...new Set(recovery.map((p) => p.level))].map((l) => [
              l,
              {
                true_mean: Math.round(mean(recovery.filter((p) => p.level === l).map((p) => p.truth)) * 1000) / 1000,
                estimated_mean: Math.round(mean(recovery.filter((p) => p.level === l).map((p) => p.est)) * 1000) / 1000,
              },
            ]),
          ),
        }
      : null,
    note:
      "Synthetic participants are SDT observers with known meta-d'/d' (Maniscalco & Lau). Treat power as a planning aid, " +
      "and replace nuisance parameters (threshold, exclusion rate) with pilot values once available.",
  };
}

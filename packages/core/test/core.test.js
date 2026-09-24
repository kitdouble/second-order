import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as c from "../src/index.js";

const EXAMPLE = readFileSync(new URL("../examples/dots-feedback-mratio.yaml", import.meta.url), "utf8");
const spec = c.validateSpec(EXAMPLE).spec;

test("example spec validates with no errors", () => {
  const r = c.validateSpec(EXAMPLE);
  assert.deepEqual(r.errors, []);
});

test("validation errors point at the right place", () => {
  const bad = EXAMPLE.replace("trialwise: always", "trialwise: alwayz").replace("attn.passed", "attn.passd");
  const r = c.validateSpec(bad);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.path === "sequence.3.params.feedback"));
  assert.ok(r.errors.some((e) => e.path === "exclusions.3.when" && e.message.includes("attn.passd")));
});

test("pay below Prolific minimum is an error", () => {
  const r = c.validateSpec(EXAMPLE.replace("reward_per_participant: 2.70", "reward_per_participant: 1.00"));
  assert.ok(r.errors.some((e) => e.path === "recruitment.reward_per_participant"));
});

test("expressions: parse, evaluate, reject unknown names", () => {
  assert.equal(c.evalExpr("bf10 >= 10 or bf10 <= 0.1", { bf10: 12 }), true);
  assert.equal(c.evalExpr("bf10 >= 10 or bf10 <= 0.1", { bf10: 3 }), false);
  assert.equal(c.evalExpr("attn.passed == false", { "attn.passed": false }), true);
  assert.equal(c.evalExpr("not (x > 1) and y < -2", { x: 0, y: -3 }), true);
  assert.equal(c.evalExpr("x < 1", { x: null }), false);
  assert.throws(() => c.evalExpr("x < 1", {}), /Unknown name/);
  assert.throws(() => c.parseExpr("x <"), /ends too early/);
});

test("compile is deterministic for a seed and resolves $cond", () => {
  const a = c.compile(spec, { feedback: "trialwise" }, "seed1");
  const b = c.compile(spec, { feedback: "trialwise" }, "seed1");
  const d = c.compile(spec, { feedback: "none" }, "seed2");
  assert.deepEqual(a, b);
  const main = a.steps.find((s) => s.id === "main");
  assert.equal(main.params.feedback, "always");
  assert.equal(main.items.length, 200);
  assert.equal(d.steps.find((s) => s.id === "main").params.feedback, "never");
  const lefts = main.items.slice(0, 50).filter((i) => i.side === "left").length;
  assert.equal(lefts, 25); // balanced within block
});

test("staircase 2down1up converges near 71% for a simulated observer", () => {
  const obs = c.drawObserver({ threshold: { mean: 10, sd: 0 }, mratio: { mean: 1, sd: 0 } }, {}, c.makeRng(3));
  let correct = 0;
  let n = 0;
  for (let s = 0; s < 20; s++) {
    const { rows } = c.simulateSession(spec, { feedback: "none" }, `st${s}`, obs);
    for (const r of rows.main.slice(50)) {
      n++;
      if (r.correct) correct++;
    }
  }
  const acc = correct / n;
  assert.ok(acc > 0.66 && acc < 0.76, `accuracy ${acc}`);
});

test("meta-d' MLE recovers the generating M-ratio", () => {
  const rng = c.makeRng(42);
  for (const mr of [0.6, 1.0]) {
    const d = 1.2;
    const md = mr * d;
    const trials = [];
    for (let i = 0; i < 20000; i++) {
      const s = rng.next() < 0.5 ? -1 : 1;
      const x1 = rng.normal((s * d) / 2, 1);
      const r = x1 > 0;
      let x2;
      do x2 = rng.normal((s * md) / 2, 1);
      while (x2 > 0 !== r);
      const dist = Math.abs(x2);
      let l = 0;
      for (let k = 1; k < 6; k++) if (dist > k * 0.5) l = k;
      trials.push({ side: s > 0 ? "right" : "left", response: r ? "right" : "left", confidence: 1 + l });
    }
    const fit = c.metaDFromTrials(trials, [1, 6]);
    assert.ok(Math.abs(fit.mratio - mr) < 0.06, `mratio ${fit.mratio} vs ${mr}`);
  }
});

test("JZS Bayes factors match BayesFactor::ttest.tstat", () => {
  // Reference values from BayesFactor 0.9.12 (rscale = 0.707).
  const ref = [
    [2, 20, 20, 1.454, 2.7889],
    [2.5, 30, 30, 3.3789, 6.6739],
    [3.5, 50, 50, 40.0945, 80.1388],
    [1, 100, 100, 0.2456, 0.4092],
    [-2, 15, 25, 1.4685, 0.1226],
  ];
  for (const [t, n1, n2, two, pos] of ref) {
    assert.ok(Math.abs(c.jzsBf10(t, n1, n2) - two) / two < 1e-3, `two-sided ${t}`);
    assert.ok(Math.abs(c.jzsBfDirectional(t, n1, n2, 0.707, "positive") - pos) / pos < 1e-3, `positive ${t}`);
  }
});

test("deficit-weighted assignment sends people to the short condition", () => {
  const keys = ["a", "b"];
  const counts = { a: { included: 95, inflight: 0 }, b: { included: 80, inflight: 0 } };
  let toB = 0;
  const rng = c.makeRng(9);
  for (let i = 0; i < 1000; i++) if (c.assignCondition(keys, counts, 100, 0.8, rng.next()).key === "b") toB++;
  assert.ok(toB > 750 && toB < 850, `toB ${toB}`); // weights 5 vs 20 -> 80%
  const full = { a: { included: 100, inflight: 0 }, b: { included: 100, inflight: 0 } };
  assert.ok(["a", "b"].includes(c.assignCondition(keys, full, 100, 0.8, 0.3).key));
});

test("semantic diff classifies wording vs design changes", () => {
  const b = c.validateSpec(
    EXAMPLE.replace("max_n: 240", "max_n: 260").replace("two boxes of dots will flash briefly", "two boxes of dots will flash"),
  ).spec;
  const d = c.diffSpecs(spec, b);
  assert.equal(d.major.length, 1);
  assert.match(d.major[0].sentence, /recruitment › max_n: 240 → 260/);
  assert.equal(d.minor.length, 1);
  assert.equal(c.isDeviation(d), true);
});

test("QA passes on the example and catches a condition that doesn't differ", () => {
  const qa = c.runQa(spec);
  assert.equal(qa.ok, true, JSON.stringify(qa.findings));
  const same = c.validateSpec(EXAMPLE.replace("trialwise: always", "trialwise: never")).spec;
  const qa2 = c.runQa(same);
  assert.ok(qa2.findings.some((f) => f.message.includes("same value in every condition")));
});

test("pilot checks evaluate over sessions", () => {
  const sessions = ["none", "trialwise"].map((lvl, i) => {
    const levels = { feedback: lvl };
    const obs = c.drawObserver(spec.simulation.truth, levels, c.makeRng(i));
    const { rows } = c.simulateSession(spec, levels, `pc${i}`, obs);
    return { rows, ...c.scoreParticipant(spec, { levels, rows }) };
  });
  const res = c.runChecks(spec.pilot.checks, sessions);
  const byId = Object.fromEntries(res.map((r) => [r.id, r]));
  assert.equal(byId.main_trials.pass, true);
  assert.equal(byId.main_accuracy.pass, true, JSON.stringify(byId.main_accuracy));
});

test("hash is stable and changes with content", async () => {
  const h1 = await c.hashSpec(spec);
  const h2 = await c.hashSpec(structuredClone(spec));
  const other = c.validateSpec(EXAMPLE.replace("max_n: 240", "max_n: 241")).spec;
  assert.equal(h1, h2);
  assert.notEqual(h1, await c.hashSpec(other));
  assert.equal(h1.length, 64);
});

test("block catalog exposes parameter schemas", () => {
  const cat = c.blockCatalog();
  const dots = cat.find((b) => b.ref === "dots-2afc-confidence@1");
  assert.ok(dots.params_schema && dots.params_schema.properties.staircase);
  assert.ok(dots.supports_sdt_measures);
});

test("embedded example matches the YAML file", () => {
  assert.equal(c.EXAMPLE_DOTS_YAML, EXAMPLE);
});

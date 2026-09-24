import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as c from "../src/index.js";

const read = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), "utf8");
const FLANKER = read("flanker-feedback.yaml");
const CUSTOM = read("custom-gonogo.yaml");

test("embedded examples match the files", () => {
  assert.equal(c.EXAMPLE_FLANKER_YAML, FLANKER);
  assert.equal(c.EXAMPLE_CUSTOM_YAML, CUSTOM);
  assert.deepEqual(Object.keys(c.EXAMPLES), ["dots", "flanker", "custom"]);
});

test("expressions accept quoted strings", () => {
  assert.equal(c.evalExpr("type == 'incongruent' and correct == true", { type: "incongruent", correct: true }), true);
  assert.equal(c.evalExpr('type != "congruent"', { type: "congruent" }), false);
});

test("flanker example validates and passes QA", () => {
  const v = c.validateSpec(FLANKER);
  assert.deepEqual(v.errors, []);
  const qa = c.runQa(v.spec);
  assert.equal(qa.ok, true, JSON.stringify(qa.blockers ?? qa));
});

test("choice-rt catches typos in responses and filters", () => {
  const bad = c.validateSpec(FLANKER.replace("correct: left", "correct: lft"));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.message.includes('"lft"')));
  const bad2 = c.validateSpec(FLANKER.replace("and correct == true\" }", "and corect == true\" }"));
  assert.equal(bad2.ok, false);
  assert.ok(bad2.errors.some((e) => e.message.includes("corect")));
});

test("filters and diff measures, including steps with per-condition params", () => {
  const spec = c.validateSpec(FLANKER).spec;
  const row = (type, correct, rt) => ({ type, correct, rt, timeout: false });
  const rows = { main: [row("congruent", true, 400), row("congruent", true, 420), row("incongruent", true, 480), row("incongruent", false, 900), row("incongruent", true, 500)] };
  // Condition matters: main's feedback param is $cond, which used to break filters.
  const s = c.scoreParticipant(spec, { levels: { feedback: "errors" }, rows });
  assert.equal(s.measures.rt_congruent, 410);
  assert.equal(s.measures.rt_incongruent, 490);
  assert.equal(s.measures.flanker_rt, 80);
  assert.ok(Math.abs(s.measures.flanker_acc - (1 - 2 / 3)) < 1e-12);
});

test("diff measures must point at existing, non-diff measures", () => {
  const bad = c.validateSpec(FLANKER.replace("a: rt_incongruent", "a: rt_incongruentt"));
  assert.equal(bad.ok, false);
  const bad2 = c.validateSpec(FLANKER.replace("a: rt_incongruent, b: rt_congruent", "a: flanker_acc, b: rt_congruent"));
  assert.equal(bad2.ok, false);
});

test("custom block: valid example warns it is unverified", () => {
  const v = c.validateSpec(CUSTOM);
  assert.deepEqual(v.errors, []);
  assert.ok(v.warnings.some((w) => /unverified|lab head/i.test(w.message)));
  const qa = c.runQa(v.spec);
  assert.equal(qa.ok, true);
});

test("custom block: code that can't run is an error", () => {
  const noDone = c.validateSpec(CUSTOM.replace(/api\.done\(\)/g, "api.finish()"));
  assert.ok(noDone.errors.some((e) => e.message.includes("api.done()")));
  const syntax = c.validateSpec(CUSTOM.replace("api.done()", "api.done("));
  assert.ok(syntax.errors.some((e) => /doesn't compile/.test(e.message)));
});

test("custom block: declared columns are the step's columns", () => {
  const bad = c.validateSpec(CUSTOM.replace("of: gonogo.rt", "of: gonogo.reaction"));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.message.includes("reaction")));
});

test("R script mirrors filters and diffs", () => {
  const spec = c.validateSpec(FLANKER).spec;
  const r = c.generateRScript(spec, { hash: "x" });
  assert.match(r, /s\[\["type"\]\] == "incongruent"/);
  assert.match(r, /out\[\["flanker_rt"\]\] <- as\.numeric\(out\[\["rt_incongruent"\]\]\) - as\.numeric\(out\[\["rt_congruent"\]\]\)/);
});

test("library: every built-in block has a runnable demo", () => {
  for (const b of c.blockCatalog()) {
    const d = c.demoSpec({ title: b.title, ref: b.ref, params: c.builtinDemoParams(b.ref) });
    assert.equal(d.ok, true, `${b.ref}: ${JSON.stringify(d.errors)}`);
  }
});

test("library: snippet round-trips and matching detects edits", () => {
  const params = c.builtinDemoParams("custom-jspsych@1");
  const entry = { name: "go-nogo", version: 2, block_ref: "custom-jspsych@1", params };
  const snip = c.librarySnippet(entry);
  const yaml = CUSTOM.replace(/sequence:\n/, "sequence:\n" + snip.split("sequence:\n")[1]).replace("blocks:\n", "blocks:\n  go_nogo: custom-jspsych@1\n");
  const v = c.validateSpec(yaml);
  assert.deepEqual(v.errors, []);
  const claims = c.libraryClaims(v.spec);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].name, "go-nogo");
  assert.equal(c.matchesLibrary(v.spec, claims[0].item, entry), true);
  const edited = c.validateSpec(yaml.replace("n_trials: 20", "n_trials: 40")).spec;
  assert.equal(c.matchesLibrary(edited, c.libraryClaims(edited)[0].item, entry), false);
  assert.equal(c.validateSpec(yaml.replace("library: go-nogo@2", "library: Go_NoGo")).ok, false);
});

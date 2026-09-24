// What a connected agent needs to know. Served in MCP initialize
// instructions (short) and via get(kind: "guide") (full).

export const SERVER_INSTRUCTIONS = `Second Order runs online behavioural experiments for the USYD Meta Lab.
A study is a YAML spec (design, blocks, measures, exclusions, analysis). You edit specs; people approve them.
Before any study work, call get with kind "guide" once, and kind "block_catalog" before writing blocks.
Workflow: edit_spec (save) -> check qa -> check simulate -> check preview -> review request -> a person approves in the web app -> pilot -> go-live.
Rules: never guess block parameters (read the catalog); fix validation errors by their path; after saving, run QA; never claim a study is approved or running unless status says so.
You cannot approve, deploy, resume or close studies: those are human-only and happen in the web app.`;

export function guideText() {
  return `# Second Order: guide for agents

## What this is
A platform where a study is a declarative, versioned YAML spec. The spec compiles to a jsPsych experiment.
Every save is an immutable version identified by its content hash. Approvals, data and reports are tied to a hash.

## Lifecycle
draft -> in_review -> approved -> piloting -> pilot_review -> live -> (paused) -> closed
- You (agent) can: save specs, fork studies, run QA, simulations and previews, request review, comment,
  resolve findings with a reason, read status and data, save analyses and notes, and (lab head/trusted only)
  operate Prolific within the approved envelope (add places, approve completed submissions, demographics).
- People (web app only): approve each gate, start the pilot and main collection, resume after a stop, close.
- The stopping rule is checked by the platform automatically after every completed session. You only read it.

## Writing a spec
1. get kind "block_catalog": the blocks, their params (JSON Schema), output columns and summary values.
2. get kind "example_spec": a complete worked example to adapt.
3. edit_spec action "save" with the full YAML. Read errors (each has a path) and fix them.
4. check kind "qa". Blockers must be fixed. Then check kind "simulate" (power, expected N, parameter recovery).
5. check kind "preview" gives links to click through each condition. Tell the person to open them.
6. review action "request" with a short summary of what changed and why.

## Spec essentials
- blocks: alias -> "block-ref@version". sequence: steps using an alias, with params and optional id.
- Between-subjects factors in design.between. Per-condition params use {$cond: factor, level_a: x, level_b: y}.
  $cond is the only logic allowed. Anything more complex needs a new block (ask a person).
- measures: fn mean|sd|median|prop|count|first (of: "<step>.<column>", optional where: "< 200"),
  or d_prime|meta_d|mratio (from: "<step>"; needs confidence).
- exclusions: [{id, when}] with expressions over measure names and block values like attn.passed.
  Operators: == != < <= > >= and or not. A missing value counts as excluded.
- analysis.primary: bf_ttest_independent on a measure, factor with 2 levels, prior {cauchy_r, direction: "a > b"}.
- analysis.stopping: check_every, min_n_per_group, max_n_per_group, stop_when over bf10, n_min, n_total.
- pilot: n_per_condition and checks, e.g. "mean(main.correct) between 0.64 and 0.78", "count(main) == 200",
  "median(main.confidence_levels_used) >= 3", "exclusion_rate <= 0.25". Levels: blocker | warning.
  Propose checks with a one-line why for each threshold; the person edits them.
- simulation.truth: threshold {mean, sd} (dots difference giving d' = 1), mratio {mean, sd, by: {factor: {level: value}}}.

## Reviewing (if you are the Lab Reviewer)
review action "next_task" returns a task with instructions, spec, QA and simulation. Follow the task's
instructions, then review action "submit_findings" with findings [{severity, path, message, suggestion, confidence}].
Severity: blocker | concern | consider. Say nothing rather than invent issues. You did not write the study.

## Analysis
get_data returns pseudonymised CSV (session ids only). report kind "r_script" gives the R script that reproduces
the platform's measures, exclusions and Bayes factor; the R output is the result of record.
When you run exploratory analyses, save them with save kind "analysis", exploratory true, and the data_hash.
Suggest analyses freely before data (they become part of the plan); after data, label everything exploratory.

## Things you must not do
- Don't state that anything is approved, live or finished unless status says so.
- Don't try to reach Prolific IDs; you will only ever see session ids.
- Don't power studies from pilot effect sizes; use pilot nuisance parameters (accuracy, variance, exclusion rate).
`;
}

export { EXAMPLE_DOTS_YAML as exampleSpecYaml } from "@so/core";

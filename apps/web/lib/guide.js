// What a connected agent needs to know. Served in MCP initialize
// instructions (short) and via get(kind: "guide") (full).

export const SERVER_INSTRUCTIONS = `Second Order runs online behavioural experiments for the USYD Meta Lab.
A study is a YAML spec (design, blocks, measures, exclusions, analysis). You edit specs; people approve them.
Before any study work, call get with kind "guide" once, and kind "block_catalog" before writing blocks.
Workflow: edit_spec (save) -> check qa -> check simulate -> check preview -> review request -> a person approves in the web app -> pilot -> go-live.
Rules: never guess block parameters (read the catalog; check the lab library before writing custom code); fix validation errors by their path; after saving, run QA; never claim a study is approved or running unless status says so.
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
2. get kind "example_spec" with name dots | flanker | custom: complete worked examples to adapt.
3. edit_spec action "save" with the full YAML. Read errors (each has a path) and fix them.
4. check kind "qa". Blockers must be fixed. Then check kind "simulate" (power, expected N, parameter recovery).
5. check kind "preview" gives links to click through each condition. Tell the person to open them.
6. review action "request" with a short summary of what changed and why.

## Spec essentials
- blocks: alias -> "block-ref@version". sequence: steps using an alias, with params and optional id.
- Between-subjects factors in design.between. Per-condition params use {$cond: factor, level_a: x, level_b: y}.
  $cond is the only logic allowed outside custom code.
- measures: fn mean|sd|median|prop|count|first (of: "<step>.<column>", optional where: "< 200"),
  or d_prime|meta_d|mratio (from: "<step>"; needs confidence), or diff (a: measure, b: measure; a minus b).
  Any non-diff measure can take filter: an expression over the step's columns that picks rows, e.g.
  filter: "type == 'incongruent' and correct == true". Strings go in single quotes.
- exclusions: [{id, when}] with expressions over measure names and block values like attn.passed.
  Operators: == != < <= > >= and or not. A missing value counts as excluded.
- analysis.primary: bf_ttest_independent on a measure, factor with 2 levels, prior {cauchy_r, direction: "a > b"}.
- analysis.stopping: check_every, min_n_per_group, max_n_per_group, stop_when over bf10, n_min, n_total.
- pilot: n_per_condition and checks, e.g. "mean(main.correct) between 0.64 and 0.78", "count(main) == 200",
  "median(main.confidence_levels_used) >= 3", "exclusion_rate <= 0.25". Levels: blocker | warning.
  Propose checks with a one-line why for each threshold; the person edits them.
- simulation.truth: threshold {mean, sd} (dots difference giving d' = 1), mratio {mean, sd, by: {factor: {level: value}}}.

## Tasks that aren't a ready-made block
Check the block catalog and the lab library first (library action "list"). A lab library task is a step someone in the lab
already built (often custom code the lab head has vetted): library action "get" gives YAML to paste. Keep its library and
params fields unchanged so it stays vetted; change params only if needed, and say that it then needs lab head approval.
library action "try" gives a link that runs one block or lab task on its own; offer it so the person can feel the task.
If nothing fits, in this order:
1. choice-rt@1 covers most speeded choice tasks: flanker, Stroop, Simon, lexical decision, categorisation, go/no-go
   with 2+ keys, anything that is "show a text/symbol stimulus, press one of 2 to 6 keys". Stimuli are a list of
   {id, text, color, position, type, correct, weight}; type is your label for filtering (congruent, incongruent, word...).
   Optional confidence and feedback. Use this whenever it fits: it gets simulation, QA and power analysis.
   See example_spec name "flanker".
2. custom-jspsych@1 for anything else (images, audio, canvas drawings, no-response trials, sequences, surveys with
   branching). You write jsPsych 8 code in params.code; it runs in a sandbox with no network access. Contract:
   - The code is a function body receiving \`api\`: api.root (element to render into; pass it as display_element),
     api.params (params.params), api.condition (e.g. {feedback: "none"}), api.rng() (seeded random, use it instead of
     Math.random), api.record(row) (once per trial) and api.done() (once, at the end, e.g. in on_finish).
   - Globals: initJsPsych and jsPsych{HtmlKeyboardResponse, HtmlButtonResponse, CanvasKeyboardResponse,
     CanvasButtonResponse, ImageKeyboardResponse, ImageButtonResponse, AudioKeyboardResponse, HtmlSliderResponse,
     SurveyLikert, SurveyMultiChoice, SurveyText, Instructions, CallFunction, Preload}. No other libraries, no fetch.
   - Declare every recorded column in params.columns with a type (integer, number, string, boolean); undeclared
     keys are dropped. Set expected_rows to the number of api.record calls (a pilot check enforces it) and est_minutes.
   - Validation checks it compiles and calls api.record and api.done. It can't check behaviour: QA and simulation
     use placeholder rows, so there is no power analysis. Tell the person to click through the preview themselves.
   - Any study with custom code needs the lab head's approval, whatever the person's tier. Say so up front.
   See example_spec name "custom".
If a custom task would be useful to others, suggest the lab head adds it to the library (library action "add", lab head
only). Tasks used by several studies are worth turning into a verified block (CLAUDE.md in the repo explains how).
Don't copy custom code between studies silently; use the library so its origin is recorded.

## Reviewing (if you are the Lab Reviewer)
review action "next_task" returns a task with instructions, spec, QA and simulation. Follow the task's
instructions, then review action "submit_findings" with findings [{severity, path, message, suggestion, confidence}].
Severity: blocker | concern | consider. Say nothing rather than invent issues. You did not write the study.

## Analysis
get_data returns pseudonymised CSV (session ids only). Use phase "preview" to inspect data from preview links
(check column names, trial counts and measures before a pilot). report kind "r_script" gives the R script that reproduces
the platform's measures, exclusions and Bayes factor; the R output is the result of record.
When you run exploratory analyses, save them with save kind "analysis", exploratory true, and the data_hash.
Suggest analyses freely before data (they become part of the plan); after data, label everything exploratory.

## Things you must not do
- Don't state that anything is approved, live or finished unless status says so.
- Don't try to reach Prolific IDs; you will only ever see session ids.
- Don't power studies from pilot effect sizes; use pilot nuisance parameters (accuracy, variance, exclusion rate).
`;
}


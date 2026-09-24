// Custom jsPsych code, written on the fly (usually by an agent) and stored in
// the spec, so it is versioned and hashed like everything else. It runs in a
// sandboxed frame that can show things and record rows, and nothing else.
// Unverified: no generative model, so simulation and QA use placeholder data.
import { z } from "zod";

export const COLUMN_TYPES = ["integer", "number", "string", "boolean"];

const params = z.strictObject({
  description: z.string().min(10).max(2000),
  code: z.string().min(20).max(100_000),
  columns: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Column names: lowercase letters, digits and _."), z.enum(COLUMN_TYPES))
    .refine((c) => Object.keys(c).length > 0 && Object.keys(c).length <= 60, "Declare 1-60 output columns."),
  expected_rows: z.number().int().min(0).max(5000).default(10),
  est_minutes: z.number().min(0.1).max(120).default(3),
  params: z.record(z.string(), z.any()).default({}),
  record: z.boolean().default(true),
});

/** Checks the code compiles (without running it). Returns an error message or null. */
export function syntaxError(code) {
  try {
    // eslint-disable-next-line no-new-func
    new Function("api", code);
    return null;
  } catch (e) {
    return e.message;
  }
}

export default {
  ref: "custom-jspsych@1",
  title: "Custom jsPsych code (unverified)",
  description:
    "Your own jsPsych code for a task no other block covers. Runs in a sandbox with jsPsych 8 and common plugins as globals " +
    "(initJsPsych, jsPsychHtmlKeyboardResponse, jsPsychHtmlButtonResponse, jsPsychCanvasKeyboardResponse, jsPsychCanvasButtonResponse, " +
    "jsPsychImageKeyboardResponse, jsPsychImageButtonResponse, jsPsychAudioKeyboardResponse, jsPsychHtmlSliderResponse, jsPsychSurveyLikert, " +
    "jsPsychSurveyMultiChoice, jsPsychSurveyText, jsPsychInstructions, jsPsychCallFunction, jsPsychPreload). " +
    "The code receives `api`: api.root (element to render into), api.params, api.condition, api.rng() (seeded random 0-1), " +
    "api.record(row) (one row per trial, keys = declared columns) and api.done() (call once at the end). " +
    "Approval follows the usual tier rules (spend-based); it isn't gated by the code itself. Simulation and QA can't model it: pilot it.",
  params,
  columns: {}, // declared per study in params.columns
  columnsFor: (p) => p.columns,
  custom: true,

  expand: (p) => Array.from({ length: p.expected_rows }, (_, i) => ({ trial: i })),
  estSeconds: (p) => p.est_minutes * 60,

  /** Placeholder rows with the declared types, so measures and QA can run. */
  simulate(p, items, obs, rng) {
    return items.map((it) => {
      const row = {};
      for (const [col, type] of Object.entries(p.columns)) {
        row[col] =
          type === "integer"
            ? it.trial
            : type === "number"
              ? Math.round(Math.exp(rng.normal(Math.log(600), 0.3)))
              : type === "boolean"
                ? rng.next() < 0.85
                : `x${rng.int(3)}`;
      }
      return row;
    });
  },

  pilotChecks: (id, p) => [
    {
      id: `${id}_rows`,
      expect: `count(${id}) == ${p.expected_rows}`,
      level: "blocker",
      why: "Custom code must record the number of rows it declares; anything else means it crashed or skipped trials.",
    },
  ],

  reviewerNotes:
    "Read the code itself: does it record one row per trial with exactly the declared columns and types, call api.done() once on every path, " +
    "use api.rng() rather than Math.random() for anything that should be reproducible, and match the instructions? Look for timing assumptions, " +
    "unhandled keys, text that reveals the hypothesis, and anything that could fail on phones.",
};

// The study spec: the single source of truth for a study.
// Authored as YAML (by people or agents), validated here, hashed, compiled.
import { z } from "zod";
import YAML from "yaml";

export const SPEC_VERSION = "0.1";

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "Use lowercase letters, digits and hyphens (2-63 chars).");
const ident = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, "Use lowercase letters, digits and _ , starting with a letter.");
const blockRef = z
  .string()
  .regex(/^[a-z0-9-]+@\d+$/, 'Block references look like "dots-2afc-confidence@1".');

const measure = z.strictObject({
  fn: z.enum(["mean", "sd", "prop", "count", "first", "median", "d_prime", "meta_d", "mratio", "diff"]),
  of: z.string().optional(), // "<seqId>.<column>"
  from: z.string().optional(), // "<seqId>" for SDT measures
  where: z.string().optional(), // e.g. "< 200", applied to the measured column
  filter: z.string().optional(), // row filter over the step's columns, e.g. "type == 'incongruent' and correct == true"
  a: z.string().optional(), // diff: measure a minus measure b
  b: z.string().optional(),
  bins: z.number().int().min(2).max(10).optional(),
});

const exclusion = z.strictObject({
  id: ident,
  when: z.string().min(1),
  note: z.string().optional(),
});

const check = z.strictObject({
  id: ident,
  expect: z.string().min(1),
  level: z.enum(["blocker", "warning"]).default("warning"),
  why: z.string().optional(),
  if_fails: z.string().optional(),
});

export const specSchema = z.strictObject({
  spec: z.union([z.literal("0.1"), z.literal(0.1)]).transform(() => SPEC_VERSION),
  study: z.strictObject({
    slug,
    title: z.string().min(3).max(200),
    owner: z.string().optional(),
    approved_protocol: z.string().optional(),
    paper: z.string().optional(),
    forked_from: z.string().optional(),
  }),
  blocks: z.record(ident, blockRef),
  design: z
    .strictObject({
      between: z.record(ident, z.array(ident).min(2).max(8)).default({}),
      assignment: z
        .strictObject({
          method: z.enum(["deficit_weighted", "simple_random"]).default("deficit_weighted"),
        })
        .default({ method: "deficit_weighted" }),
    })
    .default({ between: {}, assignment: { method: "deficit_weighted" } }),
  sequence: z
    .array(
      z.strictObject({
        use: ident,
        id: ident.optional(),
        library: z
          .string()
          .regex(/^[a-z][a-z0-9-]{1,39}@\d+$/, 'Library references look like "go-nogo@1".')
          .optional()
          .describe("Set when the step was copied from the lab library (name@version). Leave params unchanged to keep it vetted."),
        params: z.record(z.string(), z.any()).default({}),
      }),
    )
    .min(1),
  measures: z.record(ident, measure).default({}),
  exclusions: z.array(exclusion).default([]),
  recruitment: z
    .strictObject({
      platform: z.enum(["prolific", "link"]).default("prolific"),
      target_per_condition: z.number().int().min(1).max(5000).optional(),
      max_n: z.number().int().min(1).max(20000),
      est_minutes: z.number().min(1).max(240),
      reward_per_participant: z.number().min(0).max(200).optional(), // in the Prolific study's currency
      currency: z.enum(["GBP", "USD", "AUD"]).default("GBP"),
      prolific_study_id: z.string().optional(),
      completion_code: z.string().regex(/^[A-Za-z0-9]{4,20}$/).optional(),
    })
    .default({ platform: "prolific", max_n: 100, est_minutes: 10 }),
  analysis: z
    .strictObject({
      primary: z
        .strictObject({
          hypothesis: z.string().min(3),
          dv: ident,
          test: z.enum(["bf_ttest_independent"]),
          factor: ident.optional(),
          prior: z
            .strictObject({
              cauchy_r: z.number().positive().max(3).default(0.707),
              direction: z.string().optional(), // "trialwise > none"
            })
            .default({ cauchy_r: 0.707 }),
        })
        .optional(),
      stopping: z
        .strictObject({
          check_every: z.number().int().min(1).max(1000).default(10),
          min_n_per_group: z.number().int().min(2).default(20),
          max_n_per_group: z.number().int().min(2),
          stop_when: z.string().min(1),
        })
        .optional(),
      secondary: z.array(z.string()).default([]),
    })
    .default({ secondary: [] }),
  pilot: z
    .strictObject({
      n_per_condition: z.number().int().min(1).max(100).default(6),
      checks: z.array(check).default([]),
    })
    .optional(),
  simulation: z
    .strictObject({
      n_per_group: z.array(z.number().int().min(2).max(2000)).min(1).default([30, 60, 100]),
      reps: z.number().int().min(10).max(2000).default(200),
      truth: z.record(z.string(), z.any()).default({}),
    })
    .optional(),
});

/** Turns zod issues into { path, message } pairs an agent can act on. */
export function formatIssues(issues) {
  return issues.map((i) => ({
    path: i.path.length ? i.path.join(".") : "(root)",
    message: i.message,
  }));
}

/**
 * Parses YAML or JSON text (or an already-parsed object) into a spec.
 * Returns { ok: true, spec } or { ok: false, errors: [{ path, message }] }.
 */
export function parseSpec(input) {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = YAML.parse(input, { maxAliasCount: 50 });
    } catch (e) {
      return { ok: false, errors: [{ path: "(yaml)", message: e.message.split("\n")[0] }] };
    }
  }
  const r = specSchema.safeParse(raw);
  if (!r.success) return { ok: false, errors: formatIssues(r.error.issues) };
  return { ok: true, spec: r.data };
}

export function specToYaml(spec) {
  return YAML.stringify(spec, { lineWidth: 100 });
}

// General choice reaction-time task. The spec lists the stimuli, each with a
// trial type and correct response; flanker, Stroop, Simon, Posner-style and
// many categorisation tasks are all settings of this one block.
import { z } from "zod";

const stimulus = z.strictObject({
  id: z.string().regex(/^[a-z0-9_]{1,40}$/, "Use lowercase letters, digits and _."),
  text: z.string().min(1).max(200), // shown as text, never HTML
  color: z.string().regex(/^(#[0-9a-fA-F]{3,8}|[a-z]{3,20})$/).optional(),
  position: z.enum(["center", "left", "right", "top", "bottom"]).default("center"),
  type: z.string().regex(/^[a-z0-9_]{1,40}$/).default("default"), // condition label within the task, e.g. congruent
  correct: z.string(), // name of the correct response
  weight: z.number().int().min(1).max(20).default(1), // relative frequency
});

const params = z
  .strictObject({
    stimuli: z.array(stimulus).min(2).max(200),
    responses: z
      .array(z.strictObject({ name: z.string().regex(/^[a-z0-9_]{1,30}$/), key: z.string().length(1), label: z.string().max(40).optional() }))
      .min(2)
      .max(6),
    trials: z.number().int().min(1).max(2000).optional(),
    blocks: z.number().int().min(1).max(20).default(1),
    trials_per_block: z.number().int().min(1).max(2000).optional(),
    fixation_ms: z.number().int().min(0).max(5000).default(500),
    stim_ms: z.number().int().min(16).max(10000).nullable().default(null), // null: stays until response
    response_window_ms: z.number().int().min(100).max(20000).nullable().default(2000), // null: no time limit
    iti_ms: z.number().int().min(0).max(5000).default(300),
    feedback: z.enum(["never", "always", "errors"]).default("never"),
    confidence: z
      .union([
        z.literal(false),
        z.strictObject({
          scale: z.tuple([z.number().int(), z.number().int()]).default([1, 6]),
          labels: z.tuple([z.string(), z.string()]).default(["Guessing", "Certain"]),
        }),
      ])
      .default(false),
    font_size: z.number().int().min(12).max(160).default(48),
    font: z.enum(["sans", "mono"]).default("sans"),
    show_key_reminder: z.boolean().default(true),
    record: z.boolean().default(true),
    break_between_blocks: z.boolean().default(true),
  })
  .superRefine((p, ctx) => {
    const names = new Set(p.responses.map((r) => r.name));
    const keys = new Set(p.responses.map((r) => r.key.toLowerCase()));
    if (names.size !== p.responses.length) ctx.addIssue({ code: "custom", path: ["responses"], message: "Response names must differ." });
    if (keys.size !== p.responses.length) ctx.addIssue({ code: "custom", path: ["responses"], message: "Response keys must differ." });
    p.stimuli.forEach((s, i) => {
      if (!names.has(s.correct)) {
        ctx.addIssue({ code: "custom", path: ["stimuli", i, "correct"], message: `"${s.correct}" is not one of the responses (${[...names].join(", ")}).` });
      }
    });
    const ids = new Set(p.stimuli.map((s) => s.id));
    if (ids.size !== p.stimuli.length) ctx.addIssue({ code: "custom", path: ["stimuli"], message: "Stimulus ids must differ." });
  });

function counts(p) {
  const perBlock = p.trials_per_block ?? p.trials ?? p.stimuli.reduce((a, s) => a + s.weight, 0);
  return { blocks: p.blocks, perBlock, total: p.blocks * perBlock };
}

export default {
  ref: "choice-rt@1",
  title: "Choice reaction time",
  description:
    "General speeded choice task. List stimuli (text, optional colour and position) with a trial type and correct response; " +
    "set response keys, timing, feedback and optional confidence. Flanker, Stroop, Simon and similar tasks are settings of this block. " +
    "Measure effects with filtered measures, e.g. mean rt where type == 'incongruent' and correct == true, and a diff measure.",
  params,
  columns: {
    trial: "integer",
    block: "integer",
    stimulus_id: "string",
    type: "string",
    correct_response: "string",
    response: "string",
    correct: "boolean",
    timeout: "boolean",
    rt: "number",
    confidence: "number",
    confidence_rt: "number",
  },

  /** Trial order: each block holds the stimulus list repeated by weight, shuffled. */
  expand(p, rng) {
    const { blocks, perBlock } = counts(p);
    const pool = p.stimuli.flatMap((s) => Array(s.weight).fill(s));
    const items = [];
    for (let b = 0; b < blocks; b++) {
      const list = [];
      while (list.length < perBlock) list.push(...rng.shuffle(pool));
      rng
        .shuffle(list.slice(0, perBlock))
        .forEach((s, i) => items.push({ trial: b * perBlock + i, block: b, stimulus_id: s.id, type: s.type, correct_response: s.correct }));
    }
    return items;
  },

  estSeconds(p) {
    const { total, blocks } = counts(p);
    const perTrial = (p.fixation_ms + p.iti_ms) / 1000 + 0.7 + (p.confidence ? 1.2 : 0) + (p.feedback !== "never" ? 0.5 : 0);
    return total * perTrial + (p.break_between_blocks ? (blocks - 1) * 15 : 0);
  },

  /**
   * Simulated participant: log-normal RTs and a base accuracy, shifted per
   * trial type by `truth.choice.effects` (e.g. incongruent: {rt: 60, accuracy: -0.05}).
   */
  simulate(p, items, obs, rng) {
    const c = obs.choice;
    const names = p.responses.map((r) => r.name);
    return items.map((it) => {
      const eff = c.effects[it.type] ?? { rt: 0, accuracy: 0 };
      const acc = Math.min(0.999, Math.max(0.01, c.accuracy + (eff.accuracy ?? 0)));
      const correct = rng.next() < acc;
      const wrong = names.filter((n) => n !== it.correct_response);
      let rt = Math.exp(rng.normal(Math.log(Math.max(150, c.rt + (eff.rt ?? 0))), c.rtSigma));
      const timeout = p.response_window_ms !== null && rt > p.response_window_ms;
      if (timeout) rt = null;
      let confidence = null;
      if (p.confidence && !timeout) {
        const [lo, hi] = p.confidence.scale;
        const centre = correct ? 0.72 : 0.4;
        confidence = Math.min(hi, Math.max(lo, Math.round(lo + (hi - lo) * (centre + rng.normal(0, 0.18)))));
      }
      return {
        trial: it.trial,
        block: it.block,
        stimulus_id: it.stimulus_id,
        type: it.type,
        correct_response: it.correct_response,
        response: timeout ? null : correct ? it.correct_response : rng.pick(wrong),
        correct: timeout ? false : correct,
        timeout,
        rt: rt === null ? null : Math.round(rt),
        confidence,
        confidence_rt: confidence === null ? null : Math.round(Math.exp(rng.normal(Math.log(900), 0.3))),
      };
    });
  },

  pilotChecks(id, p) {
    const checks = [
      { id: `${id}_trials`, expect: `count(${id}) == ${counts(p).total}`, level: "blocker", why: "Every session should record every trial." },
      {
        id: `${id}_accuracy`,
        expect: `mean(${id}.correct) between 0.75 and 0.99`,
        level: "warning",
        why: "Speeded choice tasks usually sit around 85-97% correct; far outside that suggests wrong key mapping or unclear instructions.",
      },
    ];
    if (p.response_window_ms !== null) {
      checks.push({
        id: `${id}_timeouts`,
        expect: `mean(${id}.timeout) <= 0.05`,
        level: "warning",
        why: "Many timeouts mean the response window is too short.",
      });
    }
    return checks;
  },

  reviewerNotes:
    "Check each stimulus's correct response (e.g. flanker centre arrow, Stroop ink colour, not the word), that instructions name the same keys, " +
    "that trial types are balanced as intended (weights), and that effect measures filter on the right type and on correct trials.",
};

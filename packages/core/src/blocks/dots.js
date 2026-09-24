// Dot numerosity 2AFC with optional confidence, feedback and staircase.
// Two boxes of dots are flashed; the participant picks the box with more dots.
import { z } from "zod";

const staircase = z.union([
  z.strictObject({
    rule: z.enum(["2down1up", "3down1up"]).default("2down1up"),
    start_diff: z.number().int().min(1).max(200).default(20),
    step: z.array(z.number().int().min(1)).min(1).default([4, 2, 1]),
    min_diff: z.number().int().min(1).default(1),
    max_diff: z.number().int().min(2).default(100),
  }),
  z.strictObject({ continue_from: z.string() }),
  z.strictObject({ fixed_diff: z.number().int().min(1) }),
]);

const params = z.strictObject({
  trials: z.number().int().min(1).max(1000).optional(),
  blocks: z.number().int().min(1).max(20).default(1),
  trials_per_block: z.number().int().min(1).max(1000).optional(),
  feedback: z.enum(["never", "always"]).default("never"),
  staircase: staircase.default({ rule: "2down1up", start_diff: 20, step: [4, 2, 1], min_diff: 1, max_diff: 100 }),
  confidence: z
    .union([
      z.literal(false),
      z.strictObject({
        scale: z.tuple([z.number().int(), z.number().int()]).default([1, 6]),
        labels: z.tuple([z.string(), z.string()]).default(["Guessing", "Certain"]),
      }),
    ])
    .default({ scale: [1, 6], labels: ["Guessing", "Certain"] }),
  base_dots: z.number().int().min(20).max(500).default(150),
  stim_ms: z.number().int().min(50).max(3000).default(300),
  fixation_ms: z.number().int().min(0).max(3000).default(500),
  keys: z.strictObject({ left: z.string().length(1), right: z.string().length(1) }).default({ left: "f", right: "j" }),
  record: z.boolean().default(true),
  break_between_blocks: z.boolean().default(true),
});

function trialCounts(p) {
  const perBlock = p.trials_per_block ?? p.trials ?? 50;
  return { blocks: p.blocks, perBlock, total: p.blocks * perBlock };
}

export default {
  ref: "dots-2afc-confidence@1",
  title: "Dot numerosity 2AFC with confidence",
  description:
    "Two boxes of dots flash briefly; pick the box with more dots, then rate confidence. " +
    "Difficulty (the dot difference) is set by a staircase. Standard perceptual metacognition task " +
    "(e.g. Fleming et al., 2010).",
  params,
  columns: {
    trial: "integer",
    block: "integer",
    side: "string", // side with more dots: left | right
    response: "string",
    correct: "boolean",
    rt: "number",
    difficulty: "number",
    confidence: "number",
    confidence_rt: "number",
  },
  sdt: true, // supports d_prime / meta_d / mratio measures

  /** Deterministic trial list. Staircase values are decided online. */
  expand(p, rng) {
    const { blocks, perBlock } = trialCounts(p);
    const items = [];
    for (let b = 0; b < blocks; b++) {
      // Balanced sides within each block, shuffled.
      const sides = [];
      for (let i = 0; i < perBlock; i++) sides.push(i % 2 === 0 ? "left" : "right");
      rng.shuffle(sides).forEach((side, i) => items.push({ trial: b * perBlock + i, block: b, side }));
    }
    return items;
  },

  estSeconds(p) {
    const { total, blocks } = trialCounts(p);
    const perTrial = (p.fixation_ms + p.stim_ms) / 1000 + 0.8 + (p.confidence ? 1.2 : 0) + (p.feedback === "always" ? 0.6 : 0);
    return total * perTrial + (p.break_between_blocks ? (blocks - 1) * 15 : 0);
  },

  /**
   * Simulated participant: signal detection observer with a meta-d' level
   * confidence process (Maniscalco & Lau, 2012). d' = difficulty / threshold.
   */
  simulate(p, items, obs, rng, stair) {
    const rows = [];
    const scale = p.confidence ? p.confidence.scale : null;
    for (const it of items) {
      const diff = stair.value;
      const d = diff / obs.threshold;
      const s = it.side === "right" ? 1 : -1;
      const c = obs.bias ?? 0;
      const x1 = rng.normal((s * d) / 2, 1);
      const respRight = x1 > c;
      const correct = respRight === (s === 1);
      let confidence = null;
      if (scale) {
        const md = obs.mratio * d;
        const c2 = d > 0 ? (c * md) / d : 0;
        let x2 = 0;
        for (let k = 0; k < 200; k++) {
          x2 = rng.normal((s * md) / 2, 1);
          if (x2 > c2 === respRight) break;
        }
        const dist = Math.abs(x2 - c2);
        const levels = scale[1] - scale[0] + 1;
        let lvl = 0;
        for (let k = 1; k < levels; k++) if (dist > k * obs.confSpacing) lvl = k;
        confidence = scale[0] + lvl;
      }
      rows.push({
        trial: it.trial,
        block: it.block,
        side: it.side,
        response: respRight ? "right" : "left",
        correct,
        rt: Math.round(Math.exp(rng.normal(Math.log(obs.rtMedian ?? 700), 0.35))),
        difficulty: diff,
        confidence,
        confidence_rt: scale ? Math.round(Math.exp(rng.normal(Math.log(900), 0.3))) : null,
      });
      stair.update(correct);
    }
    return rows;
  },

  pilotChecks(id, p) {
    const rule = p.staircase?.rule ?? "2down1up";
    const target = rule === "3down1up" ? [0.72, 0.87] : [0.64, 0.78];
    const checks = [
      {
        id: `${id}_accuracy`,
        expect: `mean(${id}.correct) between ${target[0]} and ${target[1]}`,
        level: "blocker",
        why: `A ${rule} staircase should hold accuracy near ${rule === "3down1up" ? "79" : "71"}%. Outside this range the staircase or the task is misbehaving.`,
      },
      {
        id: `${id}_trials`,
        expect: `count(${id}) == ${trialCounts(p).total}`,
        level: "blocker",
        why: "Every session should record every trial; fewer means dropped data or a crash.",
      },
    ];
    if (p.confidence) {
      checks.push({
        id: `${id}_conf_use`,
        expect: `median(${id}.confidence_levels_used) >= 3`,
        level: "warning",
        why: "Participants who use only one or two confidence levels give unstable metacognition estimates.",
      });
    }
    return checks;
  },

  reviewerNotes:
    "Check that key instructions match `keys`, that feedback appears only in conditions meant to have it, " +
    "that the confidence scale labels run in the stated direction, and that practice is not recorded as main data.",
};

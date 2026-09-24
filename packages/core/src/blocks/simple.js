// Non-task blocks: consent, instructions, attention check, Likert scale, debrief.
import { z } from "zod";

const text = z.string().min(1).max(20000);

export const consent = {
  ref: "consent@1",
  title: "Consent",
  description: "Shows the participant information and records agreement. Declining ends the study.",
  params: z.strictObject({
    title: z.string().default("Participant information and consent"),
    text,
    agree_label: z.string().default("I agree to take part"),
    decline_label: z.string().default("I do not agree"),
  }),
  columns: { consented: "boolean", rt: "number" },
  expand: () => [{ trial: 0 }],
  estSeconds: (p) => 20 + p.text.split(/\s+/).length / 4,
  simulate: (p, items, obs, rng) => [{ consented: true, rt: Math.round(15000 + rng.next() * 30000) }],
  summaryKeys: ["consented"],
  summarize: (rows) => ({ consented: rows[0]?.consented ?? null }),
  pilotChecks: () => [],
  reviewerNotes: "Consent text should match the approved protocol. Declining must end the study without data being used.",
};

export const instructions = {
  ref: "instructions@1",
  title: "Instructions",
  description: "One or more pages of instructions with Next and Back buttons.",
  params: z.strictObject({
    pages: z.array(text).min(1).max(20),
    allow_back: z.boolean().default(true),
  }),
  columns: { rt: "number" },
  expand: () => [{ trial: 0 }],
  estSeconds: (p) => p.pages.reduce((s, t) => s + 5 + t.split(/\s+/).length / 4, 0),
  simulate: (p, items, obs, rng) => [{ rt: Math.round(10000 + rng.next() * 20000) }],
  pilotChecks: () => [],
  reviewerNotes: "Instructions must describe the task exactly as the block implements it (keys, what to judge, scale direction).",
};

export const attention = {
  ref: "attention-check@1",
  title: "Attention check",
  description: "A single instructed-response item. `passed` is true if the instructed option was chosen.",
  params: z.strictObject({
    item: text,
    options: z.array(z.string()).min(2).max(9).default([
      "Strongly disagree",
      "Disagree",
      "Neutral",
      "Agree",
      "Strongly agree",
    ]),
    correct: z.string(),
  }),
  columns: { response: "string", passed: "boolean", rt: "number" },
  expand: () => [{ trial: 0 }],
  estSeconds: () => 10,
  simulate: (p, items, obs, rng) => {
    const pass = rng.next() < (obs.attentionPass ?? 0.95);
    const response = pass ? p.correct : rng.pick(p.options.filter((o) => o !== p.correct));
    return [{ response, passed: pass, rt: Math.round(3000 + rng.next() * 4000) }];
  },
  summaryKeys: ["passed"],
  summarize: (rows) => ({ passed: rows[0]?.passed ?? null }),
  pilotChecks: (id) => [
    {
      id: `${id}_pass_rate`,
      expect: `mean(${id}.passed) >= 0.85`,
      level: "warning",
      why: "Low pass rates usually mean the item is ambiguous, not that participants are careless.",
    },
  ],
  reviewerNotes: "The instructed answer must be unambiguous and must be one of the options, spelled identically.",
};

export const likert = {
  ref: "likert-scale@1",
  title: "Likert questionnaire",
  description:
    "Questionnaire items on a shared rating scale, one page. `score` is the mean after reverse-scoring. " +
    "Check the instrument's licence before sharing it in a replication bundle.",
  params: z.strictObject({
    instrument: z.string().optional(),
    licence: z.string().optional(),
    preamble: z.string().optional(),
    items: z
      .array(z.strictObject({ id: z.string().regex(/^[a-z0-9_]+$/), text, reverse: z.boolean().default(false) }))
      .min(1)
      .max(100),
    scale: z
      .strictObject({
        min: z.number().int().default(1),
        max: z.number().int().default(5),
        labels: z.array(z.string()).min(2),
      })
      .refine((s) => s.labels.length === s.max - s.min + 1, "Need one label per scale point."),
    randomize: z.boolean().default(true),
  }),
  columns: { item_id: "string", response: "number", reverse: "boolean", rt: "number" },
  expand: (p, rng) => {
    const items = p.randomize ? rng.shuffle(p.items) : p.items;
    return items.map((it, i) => ({ trial: i, item_id: it.id, reverse: it.reverse }));
  },
  estSeconds: (p) => 10 + p.items.length * 5,
  simulate: (p, items, obs, rng) => {
    const trait = obs.trait ?? rng.normal(0, 1);
    const mid = (p.scale.min + p.scale.max) / 2;
    const half = (p.scale.max - p.scale.min) / 2;
    return items.map((it) => {
      const z0 = trait * 0.8 + rng.normal(0, 0.6);
      let v = Math.round(mid + (it.reverse ? -z0 : z0) * half * 0.6);
      v = Math.min(p.scale.max, Math.max(p.scale.min, v));
      return { item_id: it.item_id, response: v, reverse: it.reverse, rt: Math.round(2000 + rng.next() * 3000) };
    });
  },
  summaryKeys: ["score"],
  summarize: (rows, p) => {
    if (!rows.length) return { score: null };
    const vals = rows.map((r) => (r.reverse ? p.scale.min + p.scale.max - r.response : r.response));
    return { score: vals.reduce((a, b) => a + b, 0) / vals.length };
  },
  pilotChecks: (id, p) => [
    {
      id: `${id}_complete`,
      expect: `count(${id}) == ${p.items.length}`,
      level: "blocker",
      why: "Every item should have a response.",
    },
  ],
  reviewerNotes: "Check reverse-keyed items against the published scoring key, and that labels match the instrument.",
};

export const debrief = {
  ref: "debrief@1",
  title: "Debrief",
  description: "Final page explaining the study. Shown before the completion redirect.",
  params: z.strictObject({ text }),
  columns: { rt: "number" },
  expand: () => [{ trial: 0 }],
  estSeconds: (p) => 10 + p.text.split(/\s+/).length / 4,
  simulate: (p, items, obs, rng) => [{ rt: Math.round(8000 + rng.next() * 8000) }],
  pilotChecks: () => [],
  reviewerNotes: "The debrief should not reveal a different hypothesis from the one preregistered.",
};

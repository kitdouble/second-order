// The lab library: ready-made steps (a block plus its params) that anyone in the
// lab can drop into a study. Entries live in the database; this file holds the
// pure parts: demo specs for "try it", paste-ready snippets and matching.
import YAML from "yaml";
import { validateSpec } from "./validate.js";
import { specToYaml } from "./schema.js";
import { getBlock } from "./blocks/index.js";
import { EXAMPLES } from "./examples.js";
import { resolveCond } from "./conditions.js";
import { stepId } from "./compile.js";
import { canonicalJson } from "./hash.js";

export const LIBRARY_NAME = /^[a-z][a-z0-9-]{1,39}$/;
export const LIBRARY_REF = /^([a-z][a-z0-9-]{1,39})@(\d+)$/;

function exampleStep(example, id, levels = {}) {
  const spec = validateSpec(EXAMPLES[example].yaml).spec;
  const item = spec.sequence.find((s) => stepId(s) === id);
  return resolveCond(item.params ?? {}, levels);
}

/** Sensible params for trying each built-in block on its own. */
const BUILTIN_DEMOS = {
  "consent@1": () => ({ text: "This is the consent block. In a real study, the participant information goes here." }),
  "instructions@1": () => ({ pages: ["This is the instructions block: one or more pages.", "Participants can go Back and Next."] }),
  "attention-check@1": () => ({ item: "To show you are reading carefully, please select 'Strongly disagree'.", correct: "Strongly disagree" }),
  "likert-scale@1": () => ({
    preamble: "A demo questionnaire.",
    items: [
      { id: "q1", text: "I enjoy puzzles." },
      { id: "q2", text: "I rarely think about my own thinking.", reverse: true },
    ],
    scale: { min: 1, max: 5, labels: ["Strongly disagree", "Disagree", "Neutral", "Agree", "Strongly agree"] },
  }),
  "debrief@1": () => ({ text: "This is the debrief block, shown at the end of a study." }),
  "dots-2afc-confidence@1": () => {
    const p = exampleStep("dots", "main", { feedback: "none" });
    if (p.staircase) delete p.staircase.continue_from; // the demo has no practice step to continue from
    return p;
  },
  "choice-rt@1": () => exampleStep("flanker", "main", { feedback: "errors" }),
  "custom-jspsych@1": () => exampleStep("custom", "gonogo"),
};

export function builtinDemoParams(ref) {
  try {
    return BUILTIN_DEMOS[ref]?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * A one-step study for trying a block or library entry. Returns { yaml, spec, ok, errors }.
 * `library` is recorded on the step so the demo shows exactly the stored entry.
 */
export function demoSpec({ title, ref, params, library = null }) {
  const doc = {
    spec: "0.1",
    study: { slug: "library-demo", title: `Try it: ${title}`.slice(0, 200) },
    blocks: { task: ref, ...(ref === "debrief@1" ? {} : { end: "debrief@1" }) },
    sequence: [
      { use: "task", id: "task", ...(library ? { library } : {}), params },
      ...(ref === "debrief@1" ? [] : [{ use: "end", params: { text: "That's the end of the demo. Nothing here is analysed; you can close this tab." } }]),
    ],
    recruitment: { platform: "link", max_n: 1, est_minutes: 5 },
  };
  const yaml = specToYaml(doc);
  const v = validateSpec(yaml);
  return { yaml, spec: v.spec, ok: v.ok, errors: v.errors };
}

/** YAML to paste into a study: the block alias and the step. */
export function librarySnippet(entry, alias = null) {
  const a = alias ?? entry.name.replace(/-/g, "_").replace(/^[^a-z]+/, "").slice(0, 40);
  return YAML.stringify(
    {
      blocks: { [a]: entry.block_ref },
      sequence: [{ use: a, id: a, library: `${entry.name}@${entry.version}`, params: entry.params }],
    },
    { lineWidth: 0 },
  );
}

/** True if a study step is exactly a library entry (same block, same params). */
export function matchesLibrary(spec, item, entry) {
  return spec.blocks[item.use] === entry.block_ref && canonicalJson(item.params ?? {}) === canonicalJson(entry.params ?? {});
}

/** Steps in a spec that claim to come from the library: [{ index, id, item, name, version }]. */
export function libraryClaims(spec) {
  return (spec.sequence ?? []).flatMap((item, index) => {
    const m = item.library ? LIBRARY_REF.exec(item.library) : null;
    return m ? [{ index, id: stepId(item), item, name: m[1], version: Number(m[2]) }] : [];
  });
}

export function isCustomRef(ref) {
  return Boolean(getBlock(ref)?.custom);
}

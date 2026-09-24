// Compiles a validated spec, for one condition and one session seed, into a
// plan: an ordered list of steps with fully resolved parameters and trial lists.
// The browser runtime, the simulator and QA all consume the same plan, so a
// simulated participant runs exactly what a real one would.
import { getBlock } from "./blocks/index.js";
import { resolveCond, conditionKey } from "./conditions.js";
import { makeRng } from "./rng.js";

export const RUNTIME_VERSION = "v1";

export function stepId(item) {
  return item.id ?? item.use;
}

export function compile(spec, levels, seed) {
  const steps = spec.sequence.map((item) => {
    const ref = spec.blocks[item.use];
    const block = getBlock(ref);
    if (!block) throw new Error(`Unknown block ${ref}.`);
    const id = stepId(item);
    const params = block.params.parse(resolveCond(item.params ?? {}, levels));
    const items = block.expand(params, makeRng(`${seed}:${id}`));
    return { id, use: item.use, block: ref, params, items };
  });
  return {
    runtime: RUNTIME_VERSION,
    study: spec.study.slug,
    title: spec.study.title,
    condition: conditionKey(levels),
    levels,
    seed: String(seed),
    steps,
  };
}

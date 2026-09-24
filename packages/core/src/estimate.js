// Duration estimate from the blocks, per condition (longest condition wins).
import { getBlock } from "./blocks/index.js";
import { listConditions, resolveCond } from "./conditions.js";

export function estimateMinutes(spec) {
  let worst = 0;
  for (const c of listConditions(spec)) {
    let secs = 0;
    for (const item of spec.sequence) {
      const block = getBlock(spec.blocks[item.use]);
      const p = block.params.parse(resolveCond(item.params ?? {}, c.levels));
      secs += block.estSeconds(p);
    }
    worst = Math.max(worst, secs);
  }
  return worst / 60;
}

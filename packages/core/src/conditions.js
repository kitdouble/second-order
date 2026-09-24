// Between-subjects conditions and the $cond construct.
//
//   feedback: { $cond: feedback, none: never, trialwise: always }
//
// $cond is the only piece of logic allowed in a spec. Anything more complex
// belongs in a block.

/** All conditions: the cartesian product of the between-subjects factors. */
export function listConditions(spec) {
  const factors = Object.entries(spec.design?.between ?? {});
  if (factors.length === 0) return [{ key: "all", levels: {} }];
  let combos = [{}];
  for (const [factor, levels] of factors) {
    const next = [];
    for (const c of combos) for (const l of levels) next.push({ ...c, [factor]: l });
    combos = next;
  }
  return combos.map((levels) => ({ key: conditionKey(levels), levels }));
}

export function conditionKey(levels) {
  const parts = Object.entries(levels).map(([f, l]) => `${f}=${l}`);
  return parts.length ? parts.join("|") : "all";
}

export function parseConditionKey(key) {
  if (key === "all") return {};
  return Object.fromEntries(key.split("|").map((p) => p.split("=")));
}

const isCond = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && "$cond" in v;

/** Replaces every $cond in a value with the entry for the given condition. */
export function resolveCond(value, levels) {
  if (isCond(value)) {
    const factor = value.$cond;
    const level = levels[factor];
    if (level !== undefined && level in value) return resolveCond(value[level], levels);
    if ("default" in value) return resolveCond(value.default, levels);
    throw new Error(`No value for ${factor}=${level ?? "?"} in $cond.`);
  }
  if (Array.isArray(value)) return value.map((v) => resolveCond(v, levels));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveCond(v, levels)]));
  }
  return value;
}

/** Finds every $cond in a value, with its path, for validation. */
export function findConds(value, path = []) {
  const out = [];
  if (isCond(value)) {
    out.push({ path, node: value });
    for (const [k, v] of Object.entries(value)) if (k !== "$cond") out.push(...findConds(v, [...path, k]));
    return out;
  }
  if (Array.isArray(value)) value.forEach((v, i) => out.push(...findConds(v, [...path, i])));
  else if (value !== null && typeof value === "object")
    for (const [k, v] of Object.entries(value)) out.push(...findConds(v, [...path, k]));
  return out;
}

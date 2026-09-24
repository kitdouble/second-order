// Condition assignment. Deficit-weighted: each new session goes to a condition
// with probability proportional to how far it is from its target, counting
// included completes plus in-flight sessions discounted by the observed yield.

export function targetPerCondition(spec, nConditions) {
  return (
    spec.analysis?.stopping?.max_n_per_group ??
    spec.recruitment.target_per_condition ??
    Math.ceil(spec.recruitment.max_n / nConditions)
  );
}

/**
 * counts: { [conditionKey]: { included, inflight } }
 * yieldRate: fraction of started sessions that end up included (0.3-1).
 * Returns { key, weights }.
 */
export function assignCondition(conditionKeys, counts, target, yieldRate, u, method = "deficit_weighted") {
  if (method === "simple_random" || conditionKeys.length === 1) {
    return { key: conditionKeys[Math.min(conditionKeys.length - 1, Math.floor(u * conditionKeys.length))], weights: null };
  }
  const y = Math.min(1, Math.max(0.3, yieldRate ?? 0.8));
  const weights = conditionKeys.map((k) => {
    const c = counts[k] ?? { included: 0, inflight: 0 };
    return Math.max(0, target - c.included - c.inflight * y);
  });
  let total = weights.reduce((a, b) => a + b, 0);
  const w = total > 0 ? weights : conditionKeys.map(() => 1); // all full: spread overflow evenly
  total = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < conditionKeys.length; i++) {
    acc += w[i] / total;
    if (u < acc) return { key: conditionKeys[i], weights: Object.fromEntries(conditionKeys.map((k, j) => [k, w[j]])) };
  }
  return { key: conditionKeys.at(-1), weights: Object.fromEntries(conditionKeys.map((k, j) => [k, w[j]])) };
}

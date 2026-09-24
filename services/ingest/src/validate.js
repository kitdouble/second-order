// Validation for requests from the participant runtime. Pure functions.

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_TRIALS_PER_BATCH = 200;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const STEP = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Trial batch: { session_id, trials: [{ step, trial_index, data }] }
 * Returns { ok: true, batch } or { ok: false, error }.
 */
export function validateBatch(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const { session_id, trials } = body;
  if (typeof session_id !== "string" || !ID.test(session_id)) {
    return { ok: false, error: "session_id must be 1-128 letters, digits, _ or -." };
  }
  if (!Array.isArray(trials) || trials.length === 0) {
    return { ok: false, error: "trials must be a non-empty array." };
  }
  if (trials.length > MAX_TRIALS_PER_BATCH) {
    return { ok: false, error: `At most ${MAX_TRIALS_PER_BATCH} trials per batch.` };
  }
  const seen = new Set();
  for (const [i, t] of trials.entries()) {
    if (t === null || typeof t !== "object") return { ok: false, error: `trials[${i}] must be an object.` };
    if (typeof t.step !== "string" || !STEP.test(t.step)) return { ok: false, error: `trials[${i}].step is not a valid step id.` };
    if (!Number.isInteger(t.trial_index) || t.trial_index < 0) {
      return { ok: false, error: `trials[${i}].trial_index must be an integer >= 0.` };
    }
    const key = `${t.step}:${t.trial_index}`;
    if (seen.has(key)) return { ok: false, error: `trials[${i}] repeats ${key} in this batch.` };
    seen.add(key);
    if (t.data === null || typeof t.data !== "object" || Array.isArray(t.data)) {
      return { ok: false, error: `trials[${i}].data must be an object.` };
    }
  }
  return { ok: true, batch: { session_id, trials } };
}

/** Session start: { hash, pid?, prolific_study_id?, prolific_session_id?, preview?, cond? } */
export function validateStart(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be a JSON object." };
  const { hash, pid, prolific_study_id, prolific_session_id, preview, cond } = body;
  if (typeof hash !== "string" || !/^[0-9a-f]{12,64}$/.test(hash)) return { ok: false, error: "Bad study link." };
  for (const [k, v] of Object.entries({ pid, prolific_study_id, prolific_session_id, preview })) {
    if (v !== undefined && v !== null && (typeof v !== "string" || !ID.test(v))) return { ok: false, error: `Bad ${k}.` };
  }
  if (cond !== undefined && cond !== null && (typeof cond !== "string" || cond.length > 200)) return { ok: false, error: "Bad cond." };
  return { ok: true, start: { hash, pid, prolific_study_id, prolific_session_id, preview, cond } };
}

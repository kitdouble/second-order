// Validation for incoming trial batches. Pure functions, no I/O.

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_TRIALS_PER_BATCH = 200;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Checks a batch posted by the participant runtime.
 * Expected shape:
 *   { study_hash: string, session_id: string,
 *     trials: [{ trial_index: integer >= 0, data: object }] }
 * Returns { ok: true, batch } or { ok: false, error }.
 */
export function validateBatch(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  const { study_hash, session_id, trials } = body;

  if (typeof study_hash !== "string" || !ID_PATTERN.test(study_hash)) {
    return { ok: false, error: "study_hash must be 1-128 letters, digits, _ or -." };
  }
  if (typeof session_id !== "string" || !ID_PATTERN.test(session_id)) {
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
    if (t === null || typeof t !== "object") {
      return { ok: false, error: `trials[${i}] must be an object.` };
    }
    if (!Number.isInteger(t.trial_index) || t.trial_index < 0) {
      return { ok: false, error: `trials[${i}].trial_index must be an integer >= 0.` };
    }
    if (seen.has(t.trial_index)) {
      return { ok: false, error: `trials[${i}].trial_index is repeated in this batch.` };
    }
    seen.add(t.trial_index);
    if (t.data === null || typeof t.data !== "object" || Array.isArray(t.data)) {
      return { ok: false, error: `trials[${i}].data must be an object.` };
    }
  }

  return { ok: true, batch: { study_hash, session_id, trials } };
}

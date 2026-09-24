// Talking to the ingest service: buffered, retried, idempotent.

const API = "/api/ingest";

export async function postJson(path, body, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        keepalive: JSON.stringify(body).length < 60000,
      });
      const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
      // 4xx are final answers (bad link, study full...), not network trouble.
      if (res.status < 500) return json;
      lastErr = new Error(json.error || `HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw lastErr;
}

/** Collects trial rows and sends them in batches. Safe to resend: the server ignores duplicates. */
export function createUploader(sessionId, { enabled = true } = {}) {
  let queue = [];
  let inflight = Promise.resolve();
  let failures = 0;

  function flush() {
    if (!enabled || queue.length === 0) return inflight;
    const batch = queue.splice(0, 200);
    inflight = inflight.then(async () => {
      try {
        const r = await postJson("/trials", { session_id: sessionId, trials: batch });
        if (!r.ok) throw new Error(r.error);
      } catch (e) {
        failures++;
        queue = batch.concat(queue); // keep for the next flush
      }
    });
    return inflight;
  }

  return {
    add(step, trialIndex, data) {
      if (!enabled) return;
      queue.push({ step, trial_index: trialIndex, data });
      if (queue.length >= 10) flush();
    },
    flush,
    async flushAll() {
      for (let i = 0; i < 6 && queue.length; i++) {
        await flush();
        if (queue.length) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
      await inflight;
      return queue.length === 0;
    },
    get failures() {
      return failures;
    },
  };
}

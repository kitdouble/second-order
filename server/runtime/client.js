// Browser runtime bundled around every experiment version. It owns everything that isn't the
// experiment: starting (or resuming) a run, saving each trial as it happens, reporting errors and
// progress, server-side condition assignment, and ending the study.
import { initJsPsych } from 'jspsych';
import { setContext } from '../lib/context.js';
import { exitFullscreen } from '../lib/blocks/device.js';
import { nameStimulus } from '../lib/stimuli.js';

const config = JSON.parse(document.getElementById('so-config').textContent);
const query = new URLSearchParams(location.search);
const live = config.mode === 'live';

// Previews can show the Prolific (default), SONA or lab version of the blocks with ?recruitment=sona.
const recruitment = live
  ? config.recruitment
  : (['prolific', 'sona', 'lab'].includes(query.get('recruitment')) ? query.get('recruitment') : 'prolific');

// Experience sampling: ?session=3 on the link (e.g. from a notification) runs the third session.
const session = Number.isInteger(Number(query.get('session'))) && Number(query.get('session')) >= 1 ? Number(query.get('session')) : 1;

async function post(path, body, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: JSON.stringify(body).length < 60_000,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      if (res.status < 500 || attempt >= retries) throw new Error(data.error || `Request failed (${res.status})`);
    } catch (err) {
      if (attempt >= retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let jsPsych = null;

// Inside jsPsych's own display element once it exists, so jsPsych can still write its end message there.
function message(html) {
  const target = jsPsych?.getDisplayElement() ?? document.getElementById('jspsych-target');
  target.innerHTML = html ? `<div class="so-message">${html}</div>` : '';
}

// A live run can be resumed after a reload; the server hands out a token kept in this browser.
const RESUME_KEY = `so-run:${config.token}`;
const resumeToken = {
  get: () => { try { return localStorage.getItem(RESUME_KEY); } catch { return null; } },
  set: (value) => { try { localStorage.setItem(RESUME_KEY, value); } catch { /* private mode */ } },
  clear: () => { try { localStorage.removeItem(RESUME_KEY); } catch { /* private mode */ } },
};

let run = null;
let currentName = null;
let lastIndex = null;

/* ---------- Errors ---------- */

let reported = 0;
function reportError(text, detail) {
  if (!run || reported >= 20) return;
  reported++;
  post(`/api/runs/${run.id}/events`, {
    key: run.key, kind: 'error', message: String(text).slice(0, 500), detail: String(detail ?? '').slice(0, 4000),
    trial_index: lastIndex, trial_name: currentName,
  }, { retries: 1 }).catch(() => {});
}
window.addEventListener('error', (e) => reportError(e.message, `${e.filename}:${e.lineno}:${e.colno}\n${e.error?.stack ?? ''}`));
window.addEventListener('unhandledrejection', (e) => reportError(e.reason?.message ?? e.reason, e.reason?.stack));

/* ---------- Run ---------- */

export async function start(experiment) {
  if (!live) {
    const banner = document.createElement('div');
    banner.className = 'so-banner';
    banner.textContent = `Preview (revision ${config.version}): responses are saved as test data.`;
    document.body.prepend(banner);
    document.body.classList.add('so-preview');
  }

  try {
    run = await post('/api/runs', { token: config.token, params: Object.fromEntries(query), resume: live ? resumeToken.get() : null });
  } catch (err) {
    return message(`<p>${escape(err.message)}</p>`);
  }
  if (live && run.resume_token) resumeToken.set(run.resume_token);
  const resume = run.resume; // { block, trial_offset } when continuing an earlier attempt
  const offset = resume?.trial_offset ?? 0;

  // Trials are saved one at a time, in order, so a participant who drops out still leaves data.
  let queue = Promise.resolve();
  let saveFailed = false;
  let saved = offset;
  let rowsThisAttempt = 0;
  const enqueue = (fn) => {
    queue = queue.then(fn).catch(() => { saveFailed = true; });
  };

  const options = experiment.options ?? {};
  jsPsych = initJsPsych({
    ...options,
    display_element: 'jspsych-target',
    on_trial_start(trial) {
      currentName = trial.name ?? null;
      return options.on_trial_start?.(trial);
    },
    on_data_update(data) {
      // Rows are numbered by the runtime, 0, 1, 2, … continuing across attempts: jsPsych's own index also
      // counts skipped blocks, which would leave gaps and let a resumed run's rows collide.
      data.trial_index = offset + rowsThisAttempt++;
      data.trial_name = currentName;
      if (run.attempt > 1) data.attempt = run.attempt;
      nameStimulus(data);
      lastIndex = data.trial_index;
      const name = currentName;
      enqueue(async () => {
        await post(`/api/runs/${run.id}/data`, { key: run.key, trial_index: data.trial_index, trial_name: name, data });
        saved++;
      });
      options.on_data_update?.(data);
    },
    async on_finish(data) {
      await options.on_finish?.(data);
      exitFullscreen();
      // A block that ends the run early (device check, failed preload) records why; jsPsych shows its
      // message after this returns, and the participant is not sent to the completion link.
      const stopped = data.values().find((row) => row.stopped)?.stopped ?? null;
      message('<p>Saving your responses…</p>');
      await queue;
      if (saveFailed) return message('<p>Some responses could not be saved. Please contact the researcher.</p>');
      try {
        const { redirect } = await post(`/api/runs/${run.id}/finish`, { key: run.key, stopped });
        resumeToken.clear();
        if (stopped) return message('');
        // Inside the ESM phone app (iOS, and Android through its shim): the session now counts.
        window.webkit?.messageHandlers?.surveyComplete?.postMessage('completed');
        if (redirect) return window.location.replace(redirect);
        message(live
          ? '<p>Thank you, you have finished the study. You can close this window.</p>'
          : '<p>Preview finished. The data from this run is saved as test data.</p>');
      } catch (err) {
        message(`<p>${escape(err.message)}</p>`);
      }
    },
  });

  // The same seed on every attempt, so a resumed participant gets the same random choices.
  jsPsych.randomization.setSeed(run.seed);

  setContext({
    mode: config.mode, recruitment, version: config.version, session, jsPsych,
    assign: async (name, conditions) => (await post(`/api/runs/${run.id}/assign`, {
      key: run.key, name, conditions, ...(!live && query.get(name) != null && { chosen: query.get(name) }),
    })).value,
    esmCode: async (study) => (await post(`/api/runs/${run.id}/esm-code`, { key: run.key, study }, { retries: 2 })).code,
  });

  let nodes;
  try {
    nodes = await experiment.default(jsPsych, { mode: config.mode, recruitment, version: config.version, session });
    if (!Array.isArray(nodes)) throw new Error('buildTimeline must return an array.');
  } catch (err) {
    console.error(err);
    reportError(`buildTimeline failed: ${err?.message ?? err}`, err?.stack);
    return message(`<p>This study could not start.</p>${live ? '' : `<pre>${escape(err?.stack || err)}</pre>`}`);
  }

  // Checkpoint after each top-level item; a resumed run skips the items already completed and redoes
  // the one it was in (the server drops that item's partial rows).
  const startAt = resume?.block ?? 0;
  const timeline = nodes.map((node, i) => ({
    timeline: [node],
    conditional_function: () => i >= startAt,
    on_timeline_finish: () => enqueue(() => post(`/api/runs/${run.id}/checkpoint`, { key: run.key, block: i + 1, trial_count: saved })),
  }));
  await jsPsych.run(timeline);
}

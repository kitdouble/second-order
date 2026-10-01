// Browser runtime bundled around every experiment version. It owns everything that isn't the
// experiment: starting a run, saving each trial as it happens, and ending the study.
import { initJsPsych } from 'jspsych';
import { setContext } from '../lib/context.js';
import { exitFullscreen } from '../lib/blocks/device.js';

const config = JSON.parse(document.getElementById('so-config').textContent);
const query = new URLSearchParams(location.search);

// Previews can show the Prolific (default), SONA or lab version of the blocks with ?recruitment=sona.
const recruitment = config.mode === 'preview'
  ? (['prolific', 'sona', 'lab'].includes(query.get('recruitment')) ? query.get('recruitment') : 'prolific')
  : config.recruitment;

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

export async function start(experiment) {
  if (config.mode === 'preview') {
    const banner = document.createElement('div');
    banner.className = 'so-banner';
    banner.textContent = `Preview of version ${config.version}: responses are saved as test data.`;
    document.body.prepend(banner);
    document.body.classList.add('so-preview');
  }

  let run;
  try {
    run = await post('/api/runs', { token: config.token, params: Object.fromEntries(query) });
  } catch (err) {
    return message(`<p>${escape(err.message)}</p>`);
  }

  // Trials are saved one at a time, in order, so a participant who drops out still leaves data.
  let queue = Promise.resolve();
  let saveFailed = false;
  const save = (data) => {
    queue = queue
      .then(() => post(`/api/runs/${run.id}/data`, { key: run.key, trial_index: data.trial_index, data }))
      .catch(() => { saveFailed = true; });
  };

  const options = experiment.options ?? {};
  jsPsych = initJsPsych({
    ...options,
    display_element: 'jspsych-target',
    on_data_update(data) {
      save(data);
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
        if (stopped) return message('');
        if (redirect) return window.location.replace(redirect);
        message(config.mode === 'preview'
          ? '<p>Preview finished. The data from this run is saved as test data.</p>'
          : '<p>Thank you, you have finished the study. You can close this window.</p>');
      } catch (err) {
        message(`<p>${escape(err.message)}</p>`);
      }
    },
  });

  let timeline;
  try {
    setContext({ mode: config.mode, recruitment, version: config.version });
    timeline = await experiment.default(jsPsych, { mode: config.mode, recruitment, version: config.version });
  } catch (err) {
    console.error(err);
    return message(`<p>This study could not start.</p>${config.mode === 'preview' ? `<pre>${escape(err?.stack || err)}</pre>` : ''}`);
  }
  await jsPsych.run(timeline);
}

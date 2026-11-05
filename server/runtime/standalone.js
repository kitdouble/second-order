// Runtime for the standalone copy of an experiment in a study export (standalone/index.html). Same
// experiment, blocks, stimuli and consent texts as the live study, but nothing talks to a server: conditions
// are picked in the browser and the data is downloaded as CSV and JSON at the end.
//
// URL options: ?recruitment=prolific|sona|lab picks the blocks' version, ?condition=speed (or ?<name>=…
// for assignCondition(…, { name })) fixes a condition, ?session=3 runs that session of an ESM study.
import { initJsPsych } from 'jspsych';
import { setContext } from '../lib/context.js';
import { exitFullscreen } from '../lib/blocks/device.js';
import { nameStimulus } from '../lib/stimuli.js';

const config = JSON.parse(document.getElementById('so-config').textContent);
const query = new URLSearchParams(location.search);
const recruitment = ['prolific', 'sona', 'lab'].includes(query.get('recruitment')) ? query.get('recruitment') : config.recruitment;
const session = Number.isInteger(Number(query.get('session'))) && Number(query.get('session')) >= 1 ? Number(query.get('session')) : 1;
const participant = query.get('participant') || `local-${Date.now().toString(36)}`;

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let jsPsych = null;
function message(html) {
  const target = jsPsych?.getDisplayElement() ?? document.getElementById('jspsych-target');
  target.innerHTML = html ? `<div class="so-message">${html}</div>` : '';
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name, textContent: name });
  return a;
}

// Uniform random assignment (the live study balances conditions on the server), unless the URL fixes one.
async function assign(name, conditions) {
  const wanted = query.get(name);
  return conditions.includes(wanted) ? wanted : conditions[Math.floor(Math.random() * conditions.length)];
}

export async function start(experiment) {
  const options = experiment.options ?? {};
  let currentName = null;
  let rows = 0;
  jsPsych = initJsPsych({
    ...options,
    display_element: 'jspsych-target',
    on_trial_start(trial) {
      currentName = trial.name ?? null;
      return options.on_trial_start?.(trial);
    },
    on_data_update(data) {
      data.trial_index = rows++;
      data.trial_name = currentName;
      nameStimulus(data);
      options.on_data_update?.(data);
    },
    async on_finish(data) {
      await options.on_finish?.(data);
      exitFullscreen();
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const base = `${config.study}-${participant}-${stamp}`;
      const csv = download(`${base}.csv`, 'text/csv', data.csv());
      const json = download(`${base}.json`, 'application/json', data.json(true));
      message('<p>Finished. Your data:</p>');
      const box = jsPsych.getDisplayElement().querySelector('.so-message');
      box.append(csv, document.createElement('br'), json);
      box.insertAdjacentHTML('beforeend', '<p class="so-note">Nothing was sent anywhere: this copy runs only in this browser.</p>');
      csv.click();
    },
  });
  jsPsych.data.addProperties({ participant_id: participant, standalone: true });

  setContext({ mode: 'standalone', recruitment, version: config.version, session, jsPsych, assign, esmCode: async () => 'SO-STANDALONE' });

  try {
    const nodes = await experiment.default(jsPsych, { mode: 'standalone', recruitment, version: config.version, session });
    if (!Array.isArray(nodes)) throw new Error('buildTimeline must return an array.');
    await jsPsych.run(nodes);
  } catch (err) {
    console.error(err);
    message(`<p>This study could not start.</p><pre>${escape(err?.stack || err)}</pre>`);
  }
}

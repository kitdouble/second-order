// Simulation bundle entry: runs the experiment with jsPsych's data-only simulation inside the sandboxed
// worker (sim/worker.js). Mirrors runtime/client.js minus saving and redirects.
import { initJsPsych } from 'jspsych';
import { setContext } from '../lib/context.js';
import { nameStimulus } from '../lib/stimuli.js';
import * as experiment from 'second-order:experiment';

const sim = window.__SO_SIM__;
window.__soStandIns = [];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// survey-html-form: answer each field of the trial's own form with a plausible value.
function fakeFormResponse(html) {
  const doc = new DOMParser().parseFromString(`<form>${html}</form>`, 'text/html');
  const response = {};
  for (const el of doc.querySelectorAll('input[name], select[name], textarea[name]')) {
    const { name, type } = el;
    if (type === 'radio') {
      if (!(name in response)) response[name] = pick([...doc.querySelectorAll(`input[type=radio][name="${name}"]`)].map((r) => r.value));
    } else if (type === 'checkbox') {
      if (Math.random() < 0.5) response[name] = el.value || 'on';
    } else if (type === 'number' || type === 'range') {
      const min = Number(el.min || 0);
      const max = Number(el.max || min + 100);
      response[name] = String(Math.round(min + Math.random() * (max - min)));
    } else if (el.tagName === 'SELECT') {
      response[name] = pick([...el.options].map((o) => o.value).filter(Boolean)) ?? '';
    } else {
      response[name] = 'simulated';
    }
  }
  return response;
}

// Plugins without their own simulate() would otherwise wait for a real participant forever.
function standInSimulate(trial, _mode, options) {
  const plugin = trial.type?.info?.name ?? 'unknown';
  if (!window.__soStandIns.includes(plugin)) window.__soStandIns.push(plugin);
  const data = { rt: Math.round(400 + Math.random() * 2600), response: plugin === 'survey-html-form' ? fakeFormResponse(trial.html ?? '') : null };
  this.jsPsych.finishTrial({ ...data, ...(options?.data ?? {}) });
}

window.__soSimulation = (async () => {
  const options = experiment.options ?? {};
  const jsPsych = initJsPsych({
    ...options,
    display_element: 'jspsych-target',
    on_trial_start(trial) {
      // Progress, so a run that stalls can say where.
      window.__soCurrentTrial = { plugin: trial.type?.info?.name ?? 'unknown', name: trial.name ?? null, completed: jsPsych.data.get().count() };
      const proto = trial.type?.prototype;
      if (proto && typeof proto.simulate !== 'function' && trial.type.info?.name !== 'call-function') proto.simulate = standInSimulate;
      return options.on_trial_start?.(trial);
    },
  });
  const context = { mode: 'simulation', recruitment: sim.recruitment, version: sim.version };
  setContext(context);
  const timeline = await experiment.default(jsPsych, context);
  await jsPsych.simulate(timeline, 'data-only', sim.simulationOptions ?? {});
  return jsPsych.data.get().values().map(nameStimulus);
})();

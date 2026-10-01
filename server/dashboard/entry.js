// Experiment dashboard for one saved version (run origin, /d/<preview token>). The researcher sees the
// timeline, runs all of it, from any item, or only one item, and gets the recorded data at the end.
// Nothing is sent to the server: dashboard runs are for checking, not data.
//
// Routes (URL hash): none = timeline, #full, #from-2.1, #only-3. ?recruitment=sona|lab switches blocks.
import 'jspsych/css/jspsych.css';
import 'second-order:runtime.css';
import './dashboard.css';
import { initJsPsych } from 'jspsych';
import * as experiment from 'second-order:experiment';
import { setContext } from '../lib/context.js';
import { exitFullscreen } from '../lib/blocks/device.js';
import { stopMessage } from '../lib/blocks/stop.js';
import { describeTimeline, findItem, formatPath, labelsAlong, parsePath, sliceFrom, sliceOnly } from './timeline.js';

const config = JSON.parse(document.getElementById('so-config').textContent);
const query = new URLSearchParams(location.search);
const RECRUITMENT = { prolific: 'Prolific', sona: 'SONA', lab: 'Lab' };
const recruitment = query.get('recruitment') in RECRUITMENT ? query.get('recruitment') : 'prolific';
const context = { mode: 'preview', recruitment, version: config.version };
setContext(context);

const root = document.getElementById('jspsych-target');
const embedded = window.parent !== window;

/* ---------- Small DOM helper ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

// Each view is a fresh page load, so every run starts with clean jsPsych state.
const go = (hash) => {
  location.hash = hash;
  location.reload();
};
window.addEventListener('hashchange', () => location.reload());

function header(...extra) {
  return el('header', { class: 'db-header' },
    el('div', { class: 'db-brand' }, 'Second Order', el('span', {}, 'Dashboard')),
    el('div', { class: 'db-title' },
      el('h1', {}, config.title),
      el('p', { class: 'db-meta' }, `Version ${config.version}`, config.notes ? ` · ${config.notes}` : '')),
    ...extra);
}

/* ---------- Timeline view ---------- */

function recruitmentSwitch() {
  return el('div', { class: 'db-switch', role: 'group', 'aria-label': 'Show blocks for' },
    Object.entries(RECRUITMENT).map(([key, label]) => el('a', {
      class: key === recruitment ? 'active' : null,
      href: `?recruitment=${key}${location.hash}`,
    }, label)));
}

function summary() {
  const plugins = Object.keys(config.packages).filter((p) => p.startsWith('@jspsych/'));
  return el('ul', { class: 'db-summary' },
    el('li', {}, el('strong', {}, `jsPsych ${config.packages.jspsych ?? '?'}`), `${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`),
    el('li', {}, el('strong', {}, String(config.stimuli.length)), `stimul${config.stimuli.length === 1 ? 'us' : 'i'}`),
    el('li', {}, el('strong', {}, RECRUITMENT[recruitment]), 'blocks shown'));
}

function renderItem(item) {
  const number = formatPath(item.path);
  return el('li', { class: `db-item db-${item.kind}` },
    el('div', { class: 'db-row' },
      el('span', { class: 'db-number' }, number),
      el('span', { class: 'db-label' }, item.label, el('small', {}, item.details.join(' · '))),
      el('span', { class: 'db-actions' },
        el('button', { type: 'button', onclick: () => go(`from-${number}`) }, 'From here'),
        el('button', { type: 'button', onclick: () => go(`only-${number}`) }, 'Only this'))),
    item.children.length ? el('ol', {}, item.children.map(renderItem)) : null);
}

function renderTimeline(items, problem) {
  root.replaceChildren(el('main', { class: 'db-page' },
    header(recruitmentSwitch()),
    summary(),
    problem ? el('p', { class: 'db-warning' }, problem) : null,
    el('div', { class: 'db-toolbar' },
      el('button', { type: 'button', class: 'db-primary', onclick: () => go('full') }, 'Run full experiment'),
      el('span', {}, 'Runs here are not saved.')),
    el('ol', { class: 'db-timeline' }, items.map(renderItem))));
}

/* ---------- Running ---------- */

const MODE_LABELS = { full: 'Full experiment', from: 'From here to the end', only: 'Only this part' };

async function run(mode, path, items) {
  const where = path ? labelsAlong(items, path).join(' › ') : '';
  const stage = el('div', { class: 'db-stage' });
  root.replaceChildren(
    el('div', { class: 'db-runbar' },
      el('button', { type: 'button', onclick: () => go('') }, '← Timeline'),
      el('span', {}, el('strong', {}, MODE_LABELS[mode]), path ? ` · ${formatPath(path)} ${where}` : ''),
      el('button', { type: 'button', onclick: () => location.reload() }, 'Restart')),
    stage);

  const options = experiment.options ?? {};
  const jsPsych = initJsPsych({
    ...options,
    display_element: stage,
    async on_finish(data) {
      await options.on_finish?.(data);
      exitFullscreen();
      // jsPsych writes its end message after this; render the results once it has.
      setTimeout(() => finished(data.values(), mode, path), 0);
    },
  });
  const full = await experiment.default(jsPsych, context);
  const timeline = mode === 'from' ? sliceFrom(full, path) : mode === 'only' ? sliceOnly(full, path) : full;
  await jsPsych.run(timeline);
}

/* ---------- Results ---------- */

const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const csvCell = (v) => { const s = cell(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n');
}

// Inside a chat (MCP App) the page is sandboxed, so ask the host to save the file; otherwise download.
function save(filename, mimeType, text) {
  if (embedded) window.parent.postMessage({ type: 'second-order:download', filename, mimeType, text }, '*');
  else {
    const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
    el('a', { href: url, download: filename }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function finished(rows, mode, path) {
  const stopped = rows.find((r) => r.stopped)?.stopped;
  const stem = `v${config.version}-${mode}${path ? `-${formatPath(path)}` : ''}`;
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const shown = rows.slice(0, 200);

  root.replaceChildren(el('main', { class: 'db-page' },
    header(),
    el('h2', {}, stopped ? 'Run stopped early' : 'Run finished'),
    stopped ? el('div', { class: 'db-warning' }) : null,
    el('p', { class: 'db-meta' }, `${rows.length} rows, ${columns.length} columns. Not saved to Second Order.`),
    el('div', { class: 'db-toolbar' },
      el('button', { type: 'button', class: 'db-primary', onclick: () => location.reload() }, 'Run again'),
      el('button', { type: 'button', onclick: () => save(`${stem}.csv`, 'text/csv', toCsv(rows)) }, 'Download CSV'),
      el('button', { type: 'button', onclick: () => save(`${stem}.json`, 'application/json', JSON.stringify(rows, null, 2)) }, 'Download JSON'),
      el('button', { type: 'button', onclick: () => go('') }, '← Timeline')),
    el('div', { class: 'db-table' },
      el('table', {},
        el('thead', {}, el('tr', {}, columns.map((c) => el('th', {}, c)))),
        el('tbody', {}, shown.map((r) => el('tr', {}, columns.map((c) => el('td', { title: cell(r[c]) }, cell(r[c]).slice(0, 80)))))))),
    rows.length > shown.length ? el('p', { class: 'db-meta' }, `Showing the first ${shown.length} rows; downloads have all of them.`) : null));

  if (stopped) root.querySelector('.db-warning').innerHTML = stopMessage(stopped);
}

/* ---------- Start ---------- */

(async () => {
  let items;
  try {
    // Describe the timeline once, with a throwaway jsPsych instance.
    items = describeTimeline(await experiment.default(initJsPsych(), context));
  } catch (err) {
    root.replaceChildren(el('main', { class: 'db-page' }, header(recruitmentSwitch()),
      el('h2', {}, 'This version has an error'),
      el('p', { class: 'db-warning' }, String(err?.message ?? err))));
    return;
  }

  const m = location.hash.match(/^#(full|from|only)(?:-(.+))?$/);
  if (!m) return renderTimeline(items);
  const path = m[2] ? parsePath(m[2]) : null;
  if (m[1] !== 'full' && (!path || !findItem(items, path))) return renderTimeline(items, `There is no item ${m[2] ?? ''} in this version.`);
  await run(m[1], path, items);
})();

// In-chat panel (MCP App, protocol 2026-01-26) for show_dashboard and simulate.
//
//   Try it      the version's dashboard (run origin), embedded
//   Study       participant links and counts, versions (switchable), the version's stimuli
//   Simulation  the last simulate result: participant outcomes and value counts per column
//
// Talks to the host with a small hand-written JSON-RPC bridge, and to the embedded dashboard with
// postMessage (feedback on a trial, a summary of each run) so Claude hears about what the researcher did.
import './panel.css';

const RUN_ORIGIN = window.__RUN_ORIGIN__;
const $ = (selector) => document.querySelector(selector);

/* ---------- Host bridge ---------- */

let nextId = 1;
const pending = new Map();
const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
const notify = (method, params = {}) => send({ method, params });
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

let caps = {};
const state = { study: null, simulation: null, tab: 'try' };

window.addEventListener('message', (event) => {
  if (event.origin === RUN_ORIGIN && event.source === $('#frame').contentWindow) return fromDashboard(event.data);
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== '2.0') return;
  if (msg.id != null && !msg.method) {
    const waiting = pending.get(msg.id);
    pending.delete(msg.id);
    if (waiting) msg.error ? waiting.reject(msg.error) : waiting.resolve(msg.result);
  } else if (msg.method === 'ui/notifications/tool-result') {
    receive(msg.params?.structuredContent);
  } else if (msg.method === 'ui/notifications/host-context-changed') {
    applyContext(msg.params);
  } else if (msg.id != null) {
    send({ id: msg.id, result: {} }); // teardown, ping
  }
});

function applyContext(context = {}) {
  if (context.theme) document.documentElement.dataset.theme = context.theme;
  if (context.displayMode) {
    document.body.classList.toggle('fullscreen', context.displayMode === 'fullscreen');
    $('#full').textContent = context.displayMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
  }
}

// Ask our server for a fresh study state (version switch, refresh), through the host.
async function callTool(name, args) {
  const result = await request('tools/call', { name, arguments: args });
  if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'Failed');
  return result?.structuredContent;
}

/* ---------- DOM helpers ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'style') node.style.cssText = value;
    else if (value != null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((c) => c != null && c !== false));
  return node;
}

const STATUS = {
  good: ['✓', 'good'],
  warning: ['■', 'warning'],
  critical: ['✕', 'critical'],
};
const status = (kind, label) => el('span', { class: `status ${STATUS[kind][1]}` }, el('i', {}, STATUS[kind][0]), label);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

async function copy(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input?.select();
    return false;
  }
}

/* ---------- Rendering ---------- */

function receive(content) {
  if (!content?.study) return;
  if (content.simulation) state.simulation = content.simulation;
  const versionChanged = state.study?.version !== content.study.version || state.study?.id !== content.study.id;
  state.study = content.study;
  if (content.view === 'simulation') state.tab = 'sim';
  render(versionChanged);
}

function render(reloadFrame) {
  const { study } = state;
  $('#title').textContent = study.title;

  // Version switcher: only useful if the host lets us call tools.
  const select = $('#version');
  select.replaceChildren(...study.versions.map((v) => el('option', { value: v.number, selected: v.number === study.version }, `v${v.number}`)));
  select.disabled = !caps.serverTools || study.versions.length < 2;

  $('#open').disabled = false;
  $('#tab-sim').hidden = !state.simulation;
  if (state.simulation) $('#tab-sim .count').textContent = state.simulation.version === study.version ? '' : `v${state.simulation.version}`;
  if (reloadFrame) $('#frame').src = study.dashboard_url;

  renderStudy();
  if (state.simulation) renderSimulation();
  selectTab(state.tab === 'sim' && !state.simulation ? 'try' : state.tab);
}

function selectTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('active', button.dataset.tab === tab);
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${tab}`);
  sizeChanged();
}

function renderStudy() {
  const { study } = state;
  const links = study.participant_links;
  const view = $('#view-study');
  view.replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, 'Participants'),
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' }, el('strong', {}, String(study.participants.started)), el('span', {}, 'started')),
      el('div', { class: 'tile' }, el('strong', {}, String(study.participants.completed)), el('span', {}, 'completed')),
      el('div', { class: 'tile' }, el('strong', {}, String(links.filter((l) => l.status === 'open').length)), el('span', {}, 'open links'))),

    el('h3', {}, 'Participant links'),
    links.length
      ? el('ul', { class: 'rows' }, links.map((link) => {
          const input = el('input', { class: 'url', readonly: true, value: link.url, onclick: (e) => e.target.select() });
          return el('li', {},
            el('div', { class: 'grow' },
              el('div', {}, link.label || `${link.recruitment} link`, ' ', el('span', { class: 'muted' }, `· v${link.version} · ${link.recruitment}`)),
              el('small', {}, `${link.started} started · ${link.completed} completed`),
              input),
            link.status === 'open' ? status('good', 'Open') : status('warning', 'Closed'),
            el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(link.url, input)) ? 'Copied' : 'Selected'; } }, 'Copy'));
        }))
      : el('p', { class: 'muted' }, 'No participant links yet. When this version is ready, ask Claude to create one.'),

    el('h3', {}, 'Versions'),
    el('ul', { class: 'rows' }, [...study.versions].reverse().map((v) =>
      el('li', {
        class: `${v.number === study.version ? 'current' : ''} ${caps.serverTools && v.number !== study.version ? 'clickable' : ''}`,
        onclick: () => caps.serverTools && v.number !== study.version && switchVersion(v.number),
      },
        el('span', {}, `v${v.number}`),
        el('span', { class: 'grow' }, v.notes || el('span', { class: 'muted' }, 'No notes'), el('small', {}, date(v.created_at))),
        v.number === study.version ? el('span', { class: 'muted' }, 'showing') : null))),

    el('h3', {}, `Stimuli in v${study.version}`),
    study.stimuli.length
      ? el('div', { class: 'thumbs' }, study.stimuli.map((s) => el('div', { class: 'thumb', title: s.name },
          s.type.startsWith('image/') ? el('img', { src: s.url, alt: s.name, loading: 'lazy' }) : el('div', { class: 'file' }, s.name.split('.').pop()),
          el('span', {}, s.name))))
      : el('p', { class: 'muted' }, 'None.')));
}

/* Simulation: outcomes per participant, then a small single-hue bar chart per column. */
function renderSimulation() {
  const sim = state.simulation;
  const done = sim.participants.filter((p) => p.ok && !p.stopped).length;
  const stopped = sim.participants.filter((p) => p.ok && p.stopped).length;
  const failed = sim.participants.filter((p) => !p.ok).length;
  const errors = sim.participants.filter((p) => p.error);

  // Single-valued columns stay: "every participant got condition A" is exactly what to spot.
  const chart = ([column, { unit, counts }]) => {
    const entries = Object.entries(counts);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    const max = Math.max(...entries.map(([, n]) => n));
    return el('div', { class: 'chart' },
      el('h4', {}, column, el('span', { class: 'muted' }, ` · ${unit}`)),
      el('table', {}, el('tbody', {}, entries.map(([value, n]) => el('tr', {
        'data-tip': `${column} = ${value || '(empty)'}: ${n} ${unit} (${Math.round((n / total) * 100)}%)`,
      },
        el('td', { class: 'label', title: value }, value || '(empty)'),
        el('td', {}, el('div', { class: 'track' }, el('div', { class: 'fill', style: `width:${(n / max) * 100}%` }))),
        el('td', { class: 'value' }, String(n)))))));
  };
  const charts = Object.entries(sim.value_counts).slice(0, 16).map(chart);
  const technical = Object.entries(sim.technical_value_counts ?? {}).map(chart);

  $('#view-sim').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, `Simulated participants · v${sim.version} · ${sim.recruitment}`),
    el('div', { class: 'chips' },
      done ? status('good', `${done} completed`) : null,
      stopped ? status('warning', `${stopped} stopped early`) : null,
      failed ? status('critical', `${failed} failed`) : null,
      el('span', { class: 'muted', style: 'align-self:center' }, `${sim.seconds}s`)),
    sim.participants.some((p) => p.stopped)
      ? el('p', { class: 'muted' }, 'Stopped by: ', [...new Set(sim.participants.map((p) => p.stopped).filter(Boolean))].join(', '))
      : null,
    errors.length ? el('div', {}, el('h3', {}, 'Errors'), errors.slice(0, 3).map((p) => el('pre', {}, `Participant ${p.participant}: ${p.error}`))) : null,
    sim.stand_ins ? el('p', { class: 'note' }, sim.stand_ins) : null,
    charts.length
      ? el('div', {}, el('h3', {}, 'Values recorded'), el('div', { class: 'charts' }, charts))
      : el('p', { class: 'muted' }, 'No design columns with a few distinct values. Record conditions and correct answers in trial data.'),
    technical.length
      ? el('details', { class: 'technical' }, el('summary', {}, `Technical columns (${technical.length})`), el('div', { class: 'charts' }, technical))
      : null,
    el('p', { class: 'muted' }, `${plural(sim.columns.length, 'column')}: ${sim.columns.join(', ')}`),
    el('div', { style: 'margin-top:12px' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => selectTab('try') }, 'Try it in the dashboard'))));
}

// Hover tooltip for chart rows.
const tooltip = el('div', { class: 'tooltip', hidden: true });
document.body.append(tooltip);
document.addEventListener('mousemove', (e) => {
  const row = e.target.closest?.('[data-tip]');
  tooltip.hidden = !row;
  if (!row) return;
  tooltip.textContent = row.dataset.tip;
  tooltip.style.left = `${Math.min(e.clientX + 12, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${e.clientY + 14}px`;
});

async function switchVersion(number) {
  $('#title').textContent = `${state.study.title} · loading v${number}…`;
  try {
    receive(await callTool('show_dashboard', { study_id: state.study.id, version: number }));
  } catch (err) {
    $('#title').textContent = `${state.study.title} · ${err.message}`;
  }
}

/* ---------- Dashboard <-> Claude ---------- */

function sendToDashboard(message) {
  $('#frame').contentWindow?.postMessage(message, RUN_ORIGIN);
}

$('#frame').addEventListener('load', () => sendToDashboard({ type: 'second-order:embed', feedback: Boolean(caps.message) }));

async function postToChat(text) {
  await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
}

const where = () => `${state.study.title} v${state.study.version}`;

function fromDashboard(data) {
  if (data?.type === 'second-order:download') {
    const { filename, mimeType, text } = data;
    request('ui/download-file', { contents: [{ type: 'resource', resource: { uri: `file:///${filename}`, mimeType, text } }] }).catch(() => {});
  } else if (data?.type === 'second-order:feedback' && caps.message) {
    postToChat(`Feedback on ${where()}, ${data.item}: ${data.text}`).catch(() => {});
  } else if (data?.type === 'second-order:run' && caps.updateModelContext) {
    // Claude doesn't need to answer this; it just knows what the researcher tried.
    request('ui/update-model-context', {
      content: [{ type: 'text', text: `In the dashboard for ${where()}, the researcher ${data.summary}` }],
    }).catch(() => {});
  }
}

$('#feedback').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#feedback input');
  const text = input.value.trim();
  if (!text || !state.study) return;
  input.disabled = true;
  try {
    await postToChat(`Feedback on ${where()}: ${text}`);
    input.value = '';
    $('#feedback .sent').textContent = 'Sent to the chat';
  } catch {
    $('#feedback .sent').textContent = 'Could not send';
  }
  input.disabled = false;
});

/* ---------- Controls ---------- */

for (const button of document.querySelectorAll('.tabs button')) button.addEventListener('click', () => selectTab(button.dataset.tab));
$('#version').addEventListener('change', (e) => switchVersion(Number(e.target.value)));
$('#open').addEventListener('click', () => state.study && request('ui/open-link', { url: state.study.dashboard_url }).catch(() => {}));
$('#full').addEventListener('click', () =>
  request('ui/request-display-mode', { mode: document.body.classList.contains('fullscreen') ? 'inline' : 'fullscreen' })
    .then((r) => applyContext({ displayMode: r?.mode }))
    .catch(() => {}));

function sizeChanged() {
  if (initialized) notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
}

/* ---------- Start ---------- */

let initialized = false;
(async () => {
  try {
    const result = await request('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Second Order', version: '2.0.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    });
    caps = result?.hostCapabilities ?? {};
    applyContext(result?.hostContext);
    $('#feedback').hidden = !caps.message;
    initialized = true;
    notify('ui/notifications/initialized');
    sizeChanged();
  } catch {
    $('#title').textContent = 'This chat app could not show the panel. Use the link Claude gives instead.';
  }
})();

// In-chat panel (MCP App, protocol 2026-01-26) for show_dashboard and simulate.
//
//   Try it      the live experiment's dashboard (run origin), embedded
//   Study       participant status, links, the live experiment and saved versions, stimuli
//   ESM settings  ESM studies (show_esm_dashboard): the app title, Qualtrics link or own experiment, schedule and
//               open/closed, as a form saved straight to the server with set_esm_schedule; enrolment codes made
//               with create_esm_codes, to copy or download
//   ESM sessions  the notifications and sessions the experiment's `esm` export declares,
//               with a button to preview any one session in the dashboard
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
const state = { study: null, simulation: null, check: null, quality: null, esm: null, esmSettings: null, newCodes: null, frameUrl: null, previewed: null, tab: 'try' };

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
  // Inline, fit the dashboard to the height the host allows.
  const max = context.containerDimensions?.maxHeight ?? context.containerDimensions?.height;
  if (max) document.documentElement.style.setProperty('--frame-height', `${Math.max(320, Math.min(620, max - 130))}px`);
  if (context.displayMode) {
    // A dashboard that couldn't show inline usually can once it has room (our button or the host's).
    if (context.displayMode !== 'inline' && state.study && !$('#try-fallback').hidden) loadFrame(state.previewed);
    document.body.classList.toggle('fullscreen', context.displayMode === 'fullscreen');
    $('#full').textContent = context.displayMode === 'fullscreen' ? 'Exit fullscreen' : 'Fullscreen';
  }
}

// Ask our server for a fresh study state (refresh), through the host.
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
const status_ = (kind, label) => el('span', { class: `status ${STATUS[kind][1]}` }, el('i', {}, STATUS[kind][0]), label);
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
  if (content.check) state.check = content.check;
  if (content.quality) state.quality = content.quality;
  const changed = state.study?.revision !== content.study.revision || state.study?.id !== content.study.id;
  if (state.study?.id !== content.study.id) {
    state.esmSettings = null;
    state.newCodes = null;
  }
  if (content.esm_settings) state.esmSettings = content.esm_settings;
  state.study = content.study;
  if (content.view === 'esm') state.tab = 'esmset';
  if (content.view === 'simulation') state.tab = 'sim';
  if (content.view === 'check') state.tab = 'check';
  if (content.view === 'quality') state.tab = 'quality';
  render(changed);
}

function render(reloadFrame) {
  const { study } = state;
  $('#title').textContent = study.title;


  // A Qualtrics-hosted ESM study has no experiment, so nothing to try.
  const tryable = Boolean(study.dashboard_url);
  $('#open').disabled = !tryable;
  document.querySelector('.tabs [data-tab="try"]').hidden = !tryable;
  if (reloadFrame) state.esm = null; // the dashboard reports it again once it has loaded
  $('#tab-sim').hidden = !state.simulation;
  if (state.simulation) $('#tab-sim .count').textContent = state.simulation.revision === study.revision ? '' : ' (earlier)';
  if (reloadFrame && tryable) loadFrame();
  $('#tab-esmset').hidden = !state.esmSettings;

  $('#tab-check').hidden = !state.check;
  $('#tab-quality').hidden = !state.quality;
  renderStudy();
  renderEsmSettings();
  renderEsm();
  if (state.simulation) renderSimulation();
  if (state.check) renderCheck();
  if (state.quality) renderQuality();
  const missing = { try: !tryable, sim: !state.simulation, check: !state.check, quality: !state.quality, esm: !state.esm, esmset: !state.esmSettings };
  const fallback = tryable ? 'try' : state.esmSettings ? 'esmset' : 'study';
  selectTab(missing[state.tab] ? fallback : state.tab);
}

function selectTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('active', button.dataset.tab === tab);
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${tab}`);
  sizeChanged();
}

// Live counts for a link from study_status, if present.
function linkStatus(link) {
  const live = state.study.status?.links?.find((l) => l.url === link.url);
  if (!live) return null;
  return ` · ${live.in_progress} in progress · ${live.abandoned} abandoned${live.minutes?.median != null ? ` · median ${live.minutes.median} min` : ''}`;
}

async function refresh() {
  try {
    receive(await callTool('show_dashboard', { study_id: state.study.id }));
  } catch { /* keep what is shown */ }
}

const CHECK_KIND = { pass: 'good', warn: 'warning', fail: 'critical' };
const CHECK_LABEL = { pass: 'Pass', warn: 'Check', fail: 'Fix' };

function renderCheck() {
  const check = state.check;
  $('#view-check').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, `Launch check · ${check.recruitment}`),
    el('p', {}, status_(check.ready ? 'good' : 'critical', check.ready ? 'Ready' : 'Not ready'), ' ', check.summary),
    el('ul', { class: 'rows' }, check.checks.map((c) =>
      el('li', {}, status_(CHECK_KIND[c.status], CHECK_LABEL[c.status]), el('div', { class: 'grow' }, el('strong', {}, c.check), el('small', {}, c.detail))))),
    el('p', { class: 'muted' }, check.note)));
}

function renderQuality() {
  const q = state.quality;
  const tile = (value, label) => el('div', { class: 'tile' }, el('strong', {}, String(value ?? '–')), el('span', {}, label));
  const rules = Object.entries(q.rules)
    .filter(([k, v]) => v != null && !(Array.isArray(v) && !v.length) && !(k === 'fast_rt_ms' && q.rules.max_fast_share == null))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.length + ' IDs' : v}`);
  $('#view-quality').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, `Data quality${q.include_test ? ' · including previews' : ''}`),
    el('div', { class: 'tiles' },
      tile(q.sessions, 'sessions'), tile(q.completed, 'completed'), tile(q.excluded, 'excluded'), tile(q.kept, 'kept'),
      tile(q.length.median_minutes != null ? `${q.length.median_minutes}m` : null, `median length${q.length.stated_minutes ? ` (consent: ${q.length.stated_minutes}m)` : ''}`),
      q.length.prolific_pay_per_hour_at_median ? tile(q.length.prolific_pay_per_hour_at_median, 'per hour at median') : null),
    el('p', { class: 'muted' }, 'Rules: ', rules.join(' · ') || 'none'),
    Object.keys(q.exclusion_reasons).length
      ? el('div', {}, el('h3', {}, 'Why sessions are excluded'), el('ul', { class: 'rows' }, Object.entries(q.exclusion_reasons).map(([why, n]) =>
          el('li', {}, el('span', { class: 'grow' }, why), el('span', {}, plural(n, 'session'))))))
      : null,
    q.dropouts.length
      ? el('div', {}, el('h3', {}, 'Where unfinished participants stopped'), el('ul', { class: 'rows' }, q.dropouts.map((d) =>
          el('li', {}, el('span', { class: 'grow' }, d.where), el('span', {}, plural(d.participants, 'participant'))))))
      : null,
    el('h3', {}, 'Sessions'),
    el('div', { class: 'scroll' }, el('table', { class: 'grid' },
      el('thead', {}, el('tr', {}, ['Participant', 'Rev.', 'Status', 'Minutes', 'Too fast', 'Attention', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, q.participants.map((p) => el('tr', {},
        el('td', {}, p.participant ?? el('span', { class: 'muted' }, p.run_id.slice(0, 8))),
        el('td', {}, String(p.revision)),
        el('td', {}, p.status),
        el('td', {}, p.minutes ?? '–'),
        el('td', {}, p.fast_share != null ? `${Math.round(p.fast_share * 100)}%` : '–'),
        el('td', {}, p.attention ?? '–'),
        el('td', {}, p.excluded ? status_('warning', p.reasons.join('; ')) : status_('good', 'Kept'))))))),
    Object.keys(q.responses_kept_participants).length
      ? el('div', {}, el('h3', {}, 'Responses (kept participants)'), el('div', { class: 'charts' }, Object.entries(q.responses_kept_participants).slice(0, 16).map(chart)))
      : null,
    el('p', { class: 'muted' }, q.note)));
}

function renderStudy() {
  const { study } = state;
  const links = study.participant_links;
  const view = $('#view-study');
  const status = study.status;
  const p = status?.participants ?? { started: 0, completed: 0, in_progress: 0, abandoned: 0, minutes: {} };
  const tile = (value, label) => el('div', { class: 'tile' }, el('strong', {}, String(value ?? '–')), el('span', {}, label));
  view.replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, 'Participants', caps.serverTools ? el('button', { class: 'link', type: 'button', onclick: refresh }, 'Refresh') : null),
    el('div', { class: 'tiles' },
      tile(p.started, 'started'),
      tile(p.completed, 'completed'),
      tile(p.in_progress, 'in progress'),
      tile(p.abandoned, 'abandoned'),
      tile(p.minutes?.median != null ? `${p.minutes.median}m` : null, 'median length')),
    status?.errors?.length
      ? el('div', {}, el('h3', {}, 'Errors in participants\' browsers'), el('ul', { class: 'rows' }, status.errors.slice(0, 5).map((e) =>
          el('li', {}, status_('critical', `${e.participants}`), el('div', { class: 'grow' }, e.message,
            el('small', {}, [e.trials.length ? `at ${e.trials.join(', ')}` : null, e.browsers.join(', ')].filter(Boolean).join(' · ')))))))
      : null,
    status?.dropouts?.length
      ? el('div', {}, el('h3', {}, 'Where unfinished participants stopped'), el('ul', { class: 'rows' }, status.dropouts.slice(0, 5).map((d) =>
          el('li', {}, el('span', { class: 'grow' }, d.where), el('span', {}, plural(d.participants, 'participant'))))))
      : null,

    el('h3', {}, 'Participant links'),
    links.length
      ? el('ul', { class: 'rows' }, links.map((link) => {
          const input = el('input', { class: 'url', readonly: true, value: link.url, onclick: (e) => e.target.select() });
          return el('li', {},
            el('div', { class: 'grow' },
              el('div', {}, link.label || `${link.recruitment} link`, ' ', el('span', { class: 'muted' }, `· ${link.recruitment}`)),
              el('small', {}, `${link.started} started · ${link.completed} completed`, linkStatus(link)),
              input),
            link.status === 'open' ? status_('good', 'Open') : status_('warning', 'Closed'),
            el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(link.url, input)) ? 'Copied' : 'Selected'; } }, 'Copy'));
        }))
      : el('p', { class: 'muted' }, 'No participant links yet. When the experiment is ready, ask Claude to create one.'),

    el('h3', {}, 'Live experiment'),
    study.revision
      ? el('ul', { class: 'rows' }, el('li', { class: 'current' },
          el('span', {}, `Revision ${study.revision}`),
          el('span', { class: 'grow' }, study.update_notes || el('span', { class: 'muted' }, 'No notes'), el('small', {}, `Updated ${date(study.updated)}`))))
      : el('p', { class: 'muted' }, 'No experiment: this study\'s sessions run in a Qualtrics survey.'),

    el('h3', {}, 'Saved versions'),
    study.saved_versions.length
      ? el('ul', { class: 'rows' }, [...study.saved_versions].reverse().map((v) =>
          el('li', {},
            el('span', {}, `${v.version}`),
            el('span', { class: 'grow' }, v.name, el('small', {}, [v.notes, `${plural(v.files, 'file')}`, date(v.saved)].filter(Boolean).join(' · ')))))) 
      : el('p', { class: 'muted' }, 'None. Ask Claude to "save a version" to keep a snapshot you can go back to.'),

    el('h3', {}, 'Stimuli'),
    study.stimuli.length
      ? el('div', { class: 'thumbs' }, study.stimuli.map((s) => el('div', { class: 'thumb', title: s.name },
          s.type.startsWith('image/') ? el('img', { src: s.url, alt: s.name, loading: 'lazy' }) : el('div', { class: 'file' }, s.name.split('.').pop()),
          el('span', {}, s.name))))
      : el('p', { class: 'muted' }, 'None.')));
}

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

/* ESM settings: an editable form saved with set_esm_schedule, and codes made with create_esm_codes. */

// Schedule fields as the form shows them, in order. Names are set_esm_schedule's.
const ESM_NUMBERS = [
  ['prompts_per_day', 'Prompts per day', 1, 20],
  ['days', 'Days from enrolment', 1, 365],
  ['min_gap_minutes', 'Min. minutes between prompts', 1, 1440],
  ['expires_after_minutes', 'Each prompt open for (min)', 1, 1440],
];
const ESM_SWITCHES = [
  ['show_next_prompt_time', 'Show participants when their next prompt is due'],
  ['allow_reschedule', 'Let participants see the full schedule and reschedule prompts'],
  ['start_tomorrow', 'No prompts on the day of enrolment'],
  ['start_with_survey', 'Offer a first survey straight after enrolment'],
  ['one_survey_per_day', 'After one completed survey, cancel the rest of that day\'s prompts'],
  ['participant_initiated', 'Participants can also start a survey themselves (event-contingent)'],
];

let esmRendered = null; // the settings object the form was built from, so other tool results don't wipe edits

const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);

function codesCsv(codes) {
  const cell = (v) => (/[",\n]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : v ?? '');
  return ['code,label,test,created', ...codes.map((c) => [c.code, c.label, c.test ? 'yes' : '', c.created ?? ''].map(cell).join(','))].join('\n') + '\n';
}

function downloadText(filename, mimeType, text) {
  return request('ui/download-file', { contents: [{ type: 'resource', resource: { uri: `file:///${filename}`, mimeType, text } }] });
}

// The buttons under a list of codes: copy them all, or download them as CSV.
function codeActions(codes, name) {
  const box = el('textarea', { class: 'codes-text', readonly: true, rows: Math.min(codes.length, 6) }, codes.map((c) => c.code).join('\n'));
  const said = el('span', { class: 'muted' });
  return el('div', {},
    box,
    el('div', { class: 'chips' },
      el('button', { class: 'btn', type: 'button', onclick: async () => { said.textContent = (await copy(box.value, box)) ? 'Copied' : 'Selected: copy with Ctrl/Cmd+C'; } }, 'Copy all'),
      el('button', { class: 'btn', type: 'button', onclick: () => downloadText(`${name}.csv`, 'text/csv', codesCsv(codes)).then(() => { said.textContent = ''; }, () => { said.textContent = 'Download not available here: use Copy all'; }) }, 'Download CSV'),
      said));
}

// Tell Claude what the researcher did here, without asking it to reply.
function tellClaude(text) {
  if (caps.updateModelContext) request('ui/update-model-context', { content: [{ type: 'text', text: `In the ESM settings panel for ${state.study.title} (${state.study.id}), the researcher ${text}` }] }).catch(() => {});
}

const describeValue = (v) => (v == null || v === '' ? '(none)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));

function renderEsmSettings(force = false) {
  const settings = state.esmSettings;
  if (!settings) {
    esmRendered = null;
    return $('#view-esmset').replaceChildren();
  }
  if (!force && settings === esmRendered) return;
  esmRendered = settings;
  const sched = settings.schedule;
  const editable = settings.can_edit && caps.serverTools;
  const disabled = !editable;

  const title = el('input', { type: 'text', maxlength: 80, value: settings.app_title, required: true, disabled, placeholder: 'e.g. Daily mood study' });
  const mode = settings.survey_url || !settings.has_experiment ? 'qualtrics' : 'experiment';
  const modeRadio = (value, label, hint, off) => el('label', { class: 'choice' },
    el('input', { type: 'radio', name: 'esm-mode', value, checked: mode === value, disabled: disabled || off }),
    el('span', {}, el('strong', {}, label), el('small', {}, hint)));
  const surveyUrl = el('input', { type: 'url', value: settings.survey_url ?? '', disabled, placeholder: 'https://yourschool.qualtrics.com/jfe/form/SV_…' });
  const surveyField = field('Qualtrics survey link', surveyUrl, 'The anonymous link. The app adds participant, sessionNumber, notificationTime and timezone to it.');

  const type = el('select', { disabled },
    el('option', { value: 'random', selected: sched.schedule_type === 'random' }, 'Random times in the window'),
    el('option', { value: 'fixed', selected: sched.schedule_type === 'fixed' }, 'Evenly spaced through the window'));
  const start = el('input', { type: 'time', value: sched.start_time, disabled, required: true });
  const end = el('input', { type: 'time', value: sched.end_time, disabled, required: true });
  const numbers = Object.fromEntries(ESM_NUMBERS.map(([name, , min, max]) => [name, el('input', { type: 'number', min, max, step: 1, value: sched[name], disabled, required: true })]));
  const goal = el('input', { type: 'number', min: 1, max: 10000, step: 1, value: sched.goal_sessions ?? '', disabled, placeholder: 'No goal' });
  const email = el('input', { type: 'email', value: sched.contact_email ?? '', disabled, placeholder: 'No contact button' });
  const switches = Object.fromEntries(ESM_SWITCHES.map(([name]) => [name, el('input', { type: 'checkbox', checked: Boolean(sched[name]), disabled })]));
  const closed = el('input', { type: 'checkbox', checked: Boolean(settings.closed), disabled });

  const message = el('div', { class: 'form-message', role: 'status' });
  const save = el('button', { class: 'btn primary', type: 'submit', disabled }, settings.configured ? 'Save changes' : 'Set up ESM');

  const form = el('form', { class: 'esm-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('div', { class: 'form-grid' },
      field('Study name in the app', title, 'What participants see; the study title stays researcher-facing.')),
    el('h3', {}, 'Where each prompt opens'),
    el('div', { class: 'choices' },
      modeRadio('experiment', 'This study\'s experiment', settings.has_experiment ? 'Runs the live experiment; data is in get_data.' : 'Write the experiment first to use this.', !settings.has_experiment),
      modeRadio('qualtrics', 'A Qualtrics survey', 'Opens your survey; responses stay in Qualtrics.', false)),
    surveyField,
    el('h3', {}, 'Schedule'),
    el('div', { class: 'form-grid' },
      field('Prompt timing', type),
      field('Daily window starts', start, 'Participant\'s own time zone'),
      field('Daily window ends', end),
      ESM_NUMBERS.map(([name, label]) => field(label, numbers[name])),
      field('End after this many sessions', goal, 'Leave empty for no goal'),
      field('Contact email in the app', email, 'Leave empty for none')),
    el('div', { class: 'switches' }, ESM_SWITCHES.map(([name, label]) => el('label', { class: 'check' }, switches[name], el('span', {}, label)))),
    settings.configured
      ? [el('h3', {}, 'Enrolment'), el('label', { class: 'check' }, closed, el('span', {}, 'Closed: refuse new enrolments and sessions'))]
      : null,
    el('div', { class: 'form-actions' }, save, message),
    el('p', { class: 'muted' }, settings.configured
      ? 'Saved changes are live at once. Participants already enrolled keep the schedule they enrolled with.'
      : 'Defaults are MetaForge\'s. Saving makes this an ESM study; then make codes below.'));

  const currentMode = () => form.querySelector('input[name="esm-mode"]:checked')?.value ?? mode;
  const showSurvey = () => { surveyField.hidden = currentMode() !== 'qualtrics'; sizeChanged(); };
  form.addEventListener('change', (e) => e.target.name === 'esm-mode' && showSurvey());
  showSurvey();

  // Only what changed goes to the server (everything when setting up), so Claude hears exactly what moved.
  function wanted() {
    const int = (input) => (input.value === '' ? null : Number(input.value));
    const next = {
      app_title: title.value.trim(),
      survey_url: currentMode() === 'qualtrics' ? surveyUrl.value.trim() || null : null,
      schedule_type: type.value, start_time: start.value, end_time: end.value,
      ...Object.fromEntries(ESM_NUMBERS.map(([name]) => [name, int(numbers[name])])),
      goal_sessions: int(goal), contact_email: email.value.trim() || null,
      ...Object.fromEntries(ESM_SWITCHES.map(([name]) => [name, switches[name].checked])),
      ...(settings.configured && { closed: closed.checked }),
    };
    const before = { app_title: settings.app_title, survey_url: settings.survey_url, closed: Boolean(settings.closed), ...sched, goal_sessions: sched.goal_sessions ?? null, contact_email: sched.contact_email ?? null };
    return settings.configured ? Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== before[k])) : next;
  }

  function problem() {
    if (!title.value.trim()) return 'Give the study a name for the app.';
    if (currentMode() === 'qualtrics' && !/^https:\/\//.test(surveyUrl.value.trim())) return 'Paste the Qualtrics survey\'s https link.';
    for (const [name, label, min, max] of ESM_NUMBERS) {
      const n = Number(numbers[name].value);
      if (!Number.isInteger(n) || n < min || n > max) return `${label}: a whole number from ${min} to ${max}.`;
    }
    if (goal.value !== '' && !(Number.isInteger(Number(goal.value)) && Number(goal.value) >= 1)) return 'Sessions goal: a whole number, or empty.';
    if (!start.value || !end.value) return 'Give the daily window\'s start and end.';
    return null;
  }

  async function submit() {
    const bad = problem();
    if (bad) return showMessage('critical', bad);
    const changes = wanted();
    if (!Object.keys(changes).length) return showMessage('good', 'Nothing to save: no changes.');
    save.disabled = true;
    showMessage(null, 'Saving…');
    try {
      const result = await callTool('set_esm_schedule', { study_id: state.study.id, ...changes });
      state.esmSettings = result.esm_settings;
      $('#tab-esmset').hidden = false;
      renderEsmSettings(true);
      const warnings = result.result?.warnings ?? [];
      showMessage(warnings.length ? 'warning' : 'good', ['Saved. ' + (settings.configured ? 'Live now.' : 'This is now an ESM study.'), ...warnings].join(' '));
      tellClaude(`${settings.configured ? 'saved' : 'set up the ESM study with'} ${Object.entries(changes).map(([k, v]) => `${k}: ${describeValue(v)}`).join(', ')}.` +
        (warnings.length ? ` Warnings shown: ${warnings.join(' ')}` : '') +
        (result.result?.qualtrics_setup && !settings.survey_url ? ' The panel now shows the Qualtrics setup steps; the researcher may want help with them.' : ''));
    } catch (err) {
      save.disabled = false;
      showMessage('critical', err.message);
    }
  }

  function showMessage(kind, text) {
    const target = $('#view-esmset .form-message') ?? message;
    target.replaceChildren(kind ? status_(kind, kind === 'good' ? 'Done' : kind === 'warning' ? 'Check' : 'Not saved') : '', ' ', text);
    sizeChanged();
  }

  const tile = (value, label) => el('div', { class: 'tile' }, el('strong', {}, String(value ?? '–')), el('span', {}, label));
  const notEditable = !settings.can_edit
    ? 'You can view these settings; only the study\'s owner or editors can change them.'
    : !caps.serverTools ? 'This chat app can\'t save from the panel. Ask Claude in the chat to change settings or make codes.' : null;

  $('#view-esmset').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, settings.configured ? 'ESM settings' : 'Set up experience sampling',
      caps.serverTools ? el('button', { class: 'link', type: 'button', onclick: refreshEsm }, 'Refresh') : null),
    settings.configured
      ? el('div', { class: 'chips' },
          settings.closed ? status_('warning', `Closed ${date(settings.closed)}`) : status_('good', 'Open for enrolment'),
          el('span', { class: 'muted', style: 'align-self:center' }, settings.survey_url ? 'Sessions open a Qualtrics survey' : 'Sessions run this study\'s experiment'))
      : null,
    notEditable ? el('p', { class: 'note' }, notEditable) : null,
    form,
    settings.configured ? codesSection(settings, editable, tile) : null,
    settings.qualtrics_setup ? qualtricsSection(settings.qualtrics_setup) : null));
  sizeChanged();
}

function codesSection(settings, editable, tile) {
  const count = el('input', { type: 'number', min: 1, max: 500, step: 1, value: 10, disabled: !editable, required: true });
  const label = el('input', { type: 'text', maxlength: 120, disabled: !editable, placeholder: 'e.g. Wave 1' });
  const test = el('input', { type: 'checkbox', disabled: !editable });
  const message = el('div', { class: 'form-message', role: 'status' });
  const make = el('button', { class: 'btn primary', type: 'submit', disabled: !editable }, 'Generate codes');

  async function generate(e) {
    e.preventDefault();
    const n = Number(count.value);
    if (!Number.isInteger(n) || n < 1 || n > 500) return message.replaceChildren(status_('critical', 'Not made'), ' How many: 1 to 500.');
    make.disabled = true;
    message.replaceChildren('Generating…');
    try {
      const result = await callTool('create_esm_codes', { study_id: state.study.id, count: n, test: test.checked, ...(label.value.trim() && { label: label.value.trim() }) });
      const created = new Date().toISOString();
      state.newCodes = { codes: result.result.codes.map((code) => ({ code, label: label.value.trim() || null, test: test.checked, created })), test: test.checked, note: result.result.note };
      state.esmSettings = result.esm_settings;
      renderEsmSettings(true);
      tellClaude(`generated ${plural(n, test.checked ? 'test code' : 'enrolment code')}${label.value.trim() ? ` labelled "${label.value.trim()}"` : ''}.`);
    } catch (err) {
      make.disabled = false;
      message.replaceChildren(status_('critical', 'Not made'), ' ', err.message);
    }
  }

  const fresh = state.newCodes;
  const unused = settings.unused_codes;
  return el('div', {},
    el('h3', {}, 'Enrolment codes'),
    el('div', { class: 'tiles' },
      tile(settings.codes.issued, 'issued'), tile(settings.codes.unused, 'unused'), tile(settings.codes.enrolled, 'enrolled'),
      tile(settings.codes.withdrawn, 'withdrawn'), tile(settings.codes.test, 'test codes')),
    el('form', { class: 'esm-form', novalidate: true, onsubmit: generate },
      el('div', { class: 'form-grid' },
        field('How many', count, 'One per participant, single use'),
        field('Label (optional)', label, 'Kept with the codes, shown in esm_status')),
      el('label', { class: 'check' }, test, el('span', {}, 'Test codes: sessions run the preview and are saved as test data')),
      el('div', { class: 'form-actions' }, make, message)),
    fresh
      ? el('div', { class: 'new-codes' },
          el('p', {}, status_('good', `${plural(fresh.codes.length, fresh.test ? 'new test code' : 'new code')}`), ' ', el('span', { class: 'muted' }, fresh.note)),
          codeActions(fresh.codes, `esm-codes-${fresh.test ? 'test-' : ''}${fresh.created ?? new Date().toISOString().slice(0, 10)}`))
      : null,
    unused.length
      ? el('details', { class: 'technical' },
          el('summary', {}, `Unused codes made here or by Claude (${unused.length}${unused.length === 500 ? ', newest' : ''})`),
          el('div', { class: 'scroll' }, el('table', { class: 'grid' },
            el('thead', {}, el('tr', {}, ['Code', 'Label', 'Made'].map((h) => el('th', {}, h)))),
            el('tbody', {}, unused.map((c) => el('tr', {},
              el('td', { class: 'mono' }, c.code, c.test ? el('span', { class: 'muted' }, ' · test') : null),
              el('td', {}, c.label ?? el('span', { class: 'muted' }, '–')),
              el('td', {}, date(c.created))))))),
          codeActions(unused, 'esm-unused-codes'))
      : null,
    el('p', { class: 'muted' }, 'Participants install "MetaForge Live" (iPhone) or "MetaForge EMA" (Android) and enter their code. Codes given out by an intake study or Qualtrics intake are not listed here; see esm_status.'));
}

function qualtricsSection(setup) {
  const copyable = (value) => {
    const input = el('input', { class: 'url', readonly: true, value, onclick: (e) => e.target.select() });
    return el('div', { class: 'copy-row' }, input,
      el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(value, input)) ? 'Copied' : 'Selected'; } }, 'Copy'));
  };
  return el('details', { class: 'technical' },
    el('summary', {}, 'Qualtrics setup (Survey Flow)'),
    el('ol', { class: 'steps' }, setup.steps.map((s) => el('li', {}, s))),
    el('h3', {}, 'Web Service URL'),
    copyable(setup.web_service_url),
    el('h3', {}, 'Web Service query parameters'),
    el('table', { class: 'grid' }, el('tbody', {}, Object.entries(setup.web_service_query_parameters).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'mono' }, v))))),
    el('h3', {}, 'Last-page JavaScript'),
    el('pre', {}, setup.last_page_javascript),
    el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(setup.last_page_javascript)) ? 'Copied' : 'Select it above'; } }, 'Copy JavaScript'),
    el('p', { class: 'muted' }, setup.note));
}

async function refreshEsm() {
  try {
    receive(await callTool('show_esm_dashboard', { study_id: state.study.id }));
    renderEsmSettings(true);
  } catch { /* keep what is shown */ }
}

/* ESM: what participants are sent, and a way to try any session. */
function previewSession(number) {
  loadFrame(number);
  selectTab('try');
}

function notificationCard(n) {
  return n
    ? el('div', { class: 'notification' }, el('strong', {}, n.title ?? ''), el('span', {}, n.body ?? ''))
    : el('span', { class: 'muted' }, 'No notification text');
}

function renderEsm() {
  const { esm } = state.esm ?? {};
  $('#tab-esm').hidden = !esm;
  if (!esm) return $('#view-esm').replaceChildren();
  const tile = (value, label) => el('div', { class: 'tile' }, el('strong', {}, String(value ?? '–')), el('span', {}, label));
  $('#tab-esm .count').textContent = ` (${esm.sessions.length})`;
  $('#view-esm').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, 'Experience sampling'),
    el('div', { class: 'tiles' },
      tile(esm.sessions.length, esm.sessions.length === 1 ? 'session' : 'sessions'),
      tile(esm.expires_minutes != null ? `${esm.expires_minutes}m` : null, 'open for')),
    el('h3', {}, 'Notification'),
    esm.notification ? notificationCard(esm.notification) : el('p', { class: 'muted' }, 'No default notification. Sessions can set their own.'),
    el('h3', {}, 'Sessions'),
    esm.sessions.length
      ? el('div', { class: 'scroll' }, el('table', { class: 'grid' },
          el('thead', {}, el('tr', {}, ['#', 'Session', 'When', 'Notification', 'Open for', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, esm.sessions.map((s) => el('tr', { class: s.number === state.previewed ? 'current' : null },
            el('td', {}, String(s.number)),
            el('td', {}, s.name),
            el('td', {}, s.time ?? '–'),
            el('td', {}, notificationCard(s.notification)),
            el('td', {}, s.expires_minutes != null ? `${s.expires_minutes} min` : '–'),
            el('td', {}, el('button', { class: 'btn', type: 'button', onclick: () => previewSession(s.number) },
              s.number === state.previewed ? 'Previewing' : 'Preview')))))))
      : el('p', { class: 'muted' }, 'The experiment declares no sessions. Set `sessions` in its `esm` export.'),
    el('p', { class: 'muted' }, 'Preview runs the experiment as that session (context.session) in the dashboard. Nothing is saved or sent.')));
}

/* Simulation: outcomes per participant, then a small single-hue bar chart per column. */
function renderSimulation() {
  const sim = state.simulation;
  const done = sim.participants.filter((p) => p.ok && !p.stopped).length;
  const stopped = sim.participants.filter((p) => p.ok && p.stopped).length;
  const failed = sim.participants.filter((p) => !p.ok).length;
  const errors = sim.participants.filter((p) => p.error);

  const charts = Object.entries(sim.value_counts).slice(0, 16).map(chart);
  const technical = Object.entries(sim.technical_value_counts ?? {}).map(chart);

  $('#view-sim').replaceChildren(el('div', { class: 'pad' },
    el('h3', {}, `Simulated participants · ${sim.recruitment}`),
    el('div', { class: 'chips' },
      done ? status_('good', `${done} completed`) : null,
      stopped ? status_('warning', `${stopped} stopped early`) : null,
      failed ? status_('critical', `${failed} failed`) : null,
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

/* ---------- Embedded dashboard (Try it) ---------- */

// Some hosts don't show a nested page inline. The dashboard reports when it has rendered; if it doesn't,
// or reports no real size, show a card that opens it fullscreen or in the browser instead.
let readyTimer = null;

// A session number opens the dashboard on that session of an ESM study, running it straight away.
function loadFrame(session = null) {
  $('#try-fallback').hidden = true;
  $('#frame').hidden = false;
  state.previewed = session;
  if (session) {
    const url = new URL(state.study.dashboard_url);
    url.searchParams.set('session', session);
    url.hash = 'full';
    state.frameUrl = url.href;
  } else {
    state.frameUrl = state.study.dashboard_url;
  }
  $('#frame').src = state.frameUrl;
  if (state.esm) renderEsm();
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => showFallback('The dashboard did not load here.'), 6000);
}

function showFallback(reason) {
  clearTimeout(readyTimer);
  $('#frame').hidden = true;
  $('#try-fallback').hidden = false;
  $('#try-reason').textContent = reason;
  sizeChanged();
}

function dashboardReady({ width, height }) {
  clearTimeout(readyTimer);
  if (!(width > 50 && height > 80)) showFallback('There isn\'t room to show the dashboard here.');
}

$('#try-full').addEventListener('click', () => $('#full').click());
$('#try-open').addEventListener('click', () => $('#open').click());
$('#try-again').addEventListener('click', () => state.study && loadFrame(state.previewed));

/* ---------- Dashboard <-> Claude ---------- */

function sendToDashboard(message) {
  $('#frame').contentWindow?.postMessage(message, RUN_ORIGIN);
}

$('#frame').addEventListener('load', () => sendToDashboard({ type: 'second-order:embed', feedback: Boolean(caps.message) }));

async function postToChat(text) {
  await request('ui/message', { role: 'user', content: [{ type: 'text', text }] });
}

const where = () => `${state.study.title} (revision ${state.study.revision})`;

function fromDashboard(data) {
  if (data?.type === 'second-order:ready') {
    dashboardReady(data);
  } else if (data?.type === 'second-order:esm') {
    state.esm = data.esm ? data : null;
    renderEsm();
    sizeChanged();
  } else if (data?.type === 'second-order:download') {
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
$('#open').addEventListener('click', () => state.study && request('ui/open-link', { url: state.frameUrl ?? state.study.dashboard_url }).catch(() => {}));
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

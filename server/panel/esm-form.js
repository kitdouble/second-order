// The ESM settings form, shared by the in-chat panel (ESM settings tab) and the secret edit-link page.
// It shows a study's ESM settings, saves changes, makes enrolment codes and, in the panel only, manages
// edit links. The caller supplies the calls that reach the server (MCP tools in the panel, the edit-link
// API on the page), so this file only knows the shape of the settings (esmSettings in server/esm.js).
import { copy, date, el, plural, status_ } from './ui.js';

// Schedule fields as the form shows them, in order. Names are set_esm_schedule's.
const NUMBERS = [
  ['prompts_per_day', 'Prompts per day', 1, 20],
  ['days', 'Days from enrolment', 1, 365],
  ['min_gap_minutes', 'Min. minutes between prompts', 1, 1440],
  ['expires_after_minutes', 'Each prompt open for (min)', 1, 1440],
];
const SWITCHES = [
  ['show_next_prompt_time', 'Show participants when their next prompt is due'],
  ['allow_reschedule', 'Let participants see the full schedule and reschedule prompts'],
  ['start_tomorrow', 'No prompts on the day of enrolment'],
  ['start_with_survey', 'Offer a first survey straight after enrolment'],
  ['one_survey_per_day', 'After one completed survey, cancel the rest of that day\'s prompts'],
  ['participant_initiated', 'Participants can also start a survey themselves (event-contingent)'],
];

const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);
const tile = (value, label) => el('div', { class: 'tile' }, el('strong', {}, String(value ?? '–')), el('span', {}, label));
export const describeValue = (v) => (v == null || v === '' ? '(none)' : typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v));
export const describeChanges = (changes) => Object.entries(changes).map(([k, v]) => `${k}: ${describeValue(v)}`).join(', ');

function codesCsv(codes) {
  const cell = (v) => (/[",\n]/.test(v ?? '') ? `"${String(v).replace(/"/g, '""')}"` : v ?? '');
  return ['code,label,test,created', ...codes.map((c) => [c.code, c.label, c.test ? 'yes' : '', c.created ?? ''].map(cell).join(','))].join('\n') + '\n';
}

function copyRow(value) {
  const input = el('input', { class: 'url', readonly: true, value, onclick: (e) => e.target.select() });
  return el('div', { class: 'copy-row' }, input,
    el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(value, input)) ? 'Copied' : 'Selected'; } }, 'Copy'));
}

function message(kind, text, verdict) {
  return [kind ? status_(kind, verdict ?? (kind === 'good' ? 'Done' : kind === 'warning' ? 'Check' : 'Not saved')) : '', ' ', text];
}

/**
 * Show the form in `container`. Options:
 *   settings      esmSettings from the server
 *   editable      whether saving and making codes is possible here
 *   notEditable   why not, shown when it isn't
 *   save(changes)            -> { settings, warnings }            set_esm_schedule
 *   makeCodes({ count, test, label }) -> { codes, note, settings } create_esm_codes
 *   download(filename, mimeType, text) -> Promise                  optional: else only Copy all
 *   refresh()                -> settings                           optional
 *   links                    optional, panel only: { create({ label, days }) -> { url, settings }, revoke(id) -> settings }
 *   intakeSetup()            optional -> esm_intake_setup's result (codes from a Qualtrics intake survey)
 *   status()                 optional -> esm_status's result (participants and sessions)
 *   deleteStudy()            optional, self-service owner page only
 *   tell(text)               what the researcher did, for Claude (panel only)
 *   resized()                after the height changes
 * Returns { update(settings) } for new settings from elsewhere; the same object again is ignored, so
 * unsaved edits survive unrelated updates.
 */
export function mountEsmSettings(container, options) {
  const { editable, notEditable, save, makeCodes, download, refresh, links, intakeSetup, status, deleteStudy, tell = () => {}, resized = () => {} } = options;
  let settings = null;
  let newCodes = null; // the batch just made, shown until the study changes
  let newLink = null; // a link just made: its URL is shown once

  function update(next, force = false) {
    if (!force && next === settings) return;
    settings = next;
    render();
  }

  function codeActions(codes, name) {
    const box = el('textarea', { class: 'codes-text', readonly: true, rows: Math.min(codes.length, 6) }, codes.map((c) => c.code).join('\n'));
    const said = el('span', { class: 'muted' });
    return el('div', {},
      box,
      el('div', { class: 'chips' },
        el('button', { class: 'btn', type: 'button', onclick: async () => { said.textContent = (await copy(box.value, box)) ? 'Copied' : 'Selected: copy with Ctrl/Cmd+C'; } }, 'Copy all'),
        download
          ? el('button', { class: 'btn', type: 'button', onclick: () => download(`${name}.csv`, 'text/csv', codesCsv(codes)).then(() => { said.textContent = ''; }, () => { said.textContent = 'Download not available here: use Copy all'; }) }, 'Download CSV')
          : null,
        said));
  }

  function render() {
    const sched = settings.schedule;
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
    const numbers = Object.fromEntries(NUMBERS.map(([name, , min, max]) => [name, el('input', { type: 'number', min, max, step: 1, value: sched[name], disabled, required: true })]));
    const goal = el('input', { type: 'number', min: 1, max: 10000, step: 1, value: sched.goal_sessions ?? '', disabled, placeholder: 'No goal' });
    const email = el('input', { type: 'email', value: sched.contact_email ?? '', disabled, placeholder: 'No contact button' });
    const switches = Object.fromEntries(SWITCHES.map(([name]) => [name, el('input', { type: 'checkbox', checked: Boolean(sched[name]), disabled })]));
    const closed = el('input', { type: 'checkbox', checked: Boolean(settings.closed), disabled });

    const said = el('div', { class: 'form-message', role: 'status' });
    const show = (kind, text) => { said.replaceChildren(...message(kind, text)); resized(); };
    const saveButton = el('button', { class: 'btn primary', type: 'submit', disabled }, settings.configured ? 'Save changes' : 'Set up ESM');

    const form = el('form', { class: 'esm-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } },
      el('div', { class: 'form-grid' },
        field('Study name in the app', title, 'What participants see; the study title stays researcher-facing.')),
      settings.self_service
        ? el('div', { hidden: true }, modeRadio('qualtrics', '', '', false))
        : [el('h3', {}, 'Where each prompt opens'),
            el('div', { class: 'choices' },
              modeRadio('experiment', 'This study\'s experiment', settings.has_experiment ? 'Runs the live Second Order experiment.' : 'The study has no experiment yet.', !settings.has_experiment),
              modeRadio('qualtrics', 'A Qualtrics survey', 'Opens your survey; responses stay in Qualtrics.', false))],
      surveyField,
      el('h3', {}, 'Schedule'),
      el('div', { class: 'form-grid' },
        field('Prompt timing', type),
        field('Daily window starts', start, 'Participant\'s own time zone'),
        field('Daily window ends', end),
        NUMBERS.map(([name, label]) => field(label, numbers[name])),
        field('End after this many sessions', goal, 'Leave empty for no goal'),
        field('Contact email in the app', email, 'Leave empty for none')),
      el('div', { class: 'switches' }, SWITCHES.map(([name, label]) => el('label', { class: 'check' }, switches[name], el('span', {}, label)))),
      settings.configured
        ? [el('h3', {}, 'Enrolment'), el('label', { class: 'check' }, closed, el('span', {}, 'Closed: refuse new enrolments and sessions'))]
        : null,
      el('div', { class: 'form-actions' }, saveButton, said),
      el('p', { class: 'muted' }, settings.configured
        ? 'Saved changes are live at once. Participants already enrolled keep the schedule they enrolled with.'
        : 'Defaults are MetaForge\'s. Saving makes this an ESM study; then make codes below.'));

    const currentMode = () => form.querySelector('input[name="esm-mode"]:checked')?.value ?? mode;
    const showSurvey = () => { surveyField.hidden = currentMode() !== 'qualtrics'; resized(); };
    form.addEventListener('change', (e) => e.target.name === 'esm-mode' && showSurvey());
    showSurvey();

    // Only what changed goes to the server (everything when setting up), so it is clear what moved.
    function wanted() {
      const int = (input) => (input.value === '' ? null : Number(input.value));
      const next = {
        app_title: title.value.trim(),
        survey_url: currentMode() === 'qualtrics' ? surveyUrl.value.trim() || null : null,
        schedule_type: type.value, start_time: start.value, end_time: end.value,
        ...Object.fromEntries(NUMBERS.map(([name]) => [name, int(numbers[name])])),
        goal_sessions: int(goal), contact_email: email.value.trim() || null,
        ...Object.fromEntries(SWITCHES.map(([name]) => [name, switches[name].checked])),
        ...(settings.configured && { closed: closed.checked }),
      };
      const before = { app_title: settings.app_title, survey_url: settings.survey_url, closed: Boolean(settings.closed), ...sched, goal_sessions: sched.goal_sessions ?? null, contact_email: sched.contact_email ?? null };
      return settings.configured ? Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== before[k])) : next;
    }

    function problem() {
      if (!title.value.trim()) return 'Give the study a name for the app.';
      if (currentMode() === 'qualtrics' && !/^https:\/\//.test(surveyUrl.value.trim())) return 'Paste the Qualtrics survey\'s https link.';
      for (const [name, label, min, max] of NUMBERS) {
        const n = Number(numbers[name].value);
        if (!Number.isInteger(n) || n < min || n > max) return `${label}: a whole number from ${min} to ${max}.`;
      }
      if (goal.value !== '' && !(Number.isInteger(Number(goal.value)) && Number(goal.value) >= 1)) return 'Sessions goal: a whole number, or empty.';
      if (!start.value || !end.value) return 'Give the daily window\'s start and end.';
      if (email.value.trim() && !email.checkValidity()) return 'Contact email: check the address, or leave it empty.';
      return null;
    }

    async function submit() {
      const bad = problem();
      if (bad) return show('critical', bad);
      const changes = wanted();
      if (!Object.keys(changes).length) return show('good', 'Nothing to save: no changes.');
      const wasConfigured = settings.configured;
      const hadSurvey = settings.survey_url;
      saveButton.disabled = true;
      show(null, 'Saving…');
      try {
        const result = await save(changes);
        const warnings = result.warnings ?? [];
        update(result.settings, true);
        // The new form replaced this one: report there.
        container.querySelector('.form-message').replaceChildren(...message(warnings.length ? 'warning' : 'good',
          ['Saved. ' + (wasConfigured ? 'Live now.' : 'This is now an ESM study.'), ...warnings].join(' ')));
        resized();
        tell(`${wasConfigured ? 'saved' : 'set up the ESM study with'} ${describeChanges(changes)}.` +
          (warnings.length ? ` Warnings shown: ${warnings.join(' ')}` : '') +
          (result.settings.qualtrics_setup && !hadSurvey ? ' The panel now shows the Qualtrics setup steps; the researcher may want help with them.' : ''));
      } catch (err) {
        saveButton.disabled = false;
        show('critical', err.message);
      }
    }

    container.replaceChildren(el('div', { class: 'pad' },
      el('h3', {}, settings.configured ? 'ESM settings' : 'Set up experience sampling',
        refresh ? el('button', { class: 'link', type: 'button', onclick: async () => { try { update(await refresh(), true); } catch { /* keep what is shown */ } } }, 'Refresh') : null),
      settings.configured
        ? el('div', { class: 'chips' },
            settings.closed ? status_('warning', `Closed ${date(settings.closed)}`) : status_('good', 'Open for enrolment'),
            el('span', { class: 'muted', style: 'align-self:center' }, settings.survey_url ? 'Sessions open a Qualtrics survey' : 'Sessions run this study\'s experiment'))
        : null,
      !editable && notEditable ? el('p', { class: 'note' }, notEditable) : null,
      form,
      settings.configured && status ? statusSection() : null,
      settings.configured ? codesSection() : null,
      settings.configured ? el('h3', {}, 'Qualtrics instructions') : null,
      settings.qualtrics_setup ? qualtricsSection(settings.qualtrics_setup) : null,
      settings.qualtrics_setup?.session_info ? sessionInfoSection(settings.qualtrics_setup.session_info) : null,
      settings.configured && intakeSetup ? intakeSection() : null,
      links && settings.edit_links ? linksSection() : null,
      settings.self_service ? el('p', { class: 'muted' }, settings.self_service.retention, ` Due: ${date(settings.self_service.deleted_after)}, unless the study is used before then.`) : null,
      settings.self_service && deleteStudy ? deleteSection() : null));
    resized();
  }

  function codesSection() {
    const count = el('input', { type: 'number', min: 1, max: 500, step: 1, value: 10, disabled: !editable, required: true });
    const label = el('input', { type: 'text', maxlength: 120, disabled: !editable, placeholder: 'e.g. Wave 1' });
    const test = el('input', { type: 'checkbox', disabled: !editable });
    const said = el('div', { class: 'form-message', role: 'status' });
    const make = el('button', { class: 'btn primary', type: 'submit', disabled: !editable }, 'Generate codes');

    async function generate(e) {
      e.preventDefault();
      const n = Number(count.value);
      if (!Number.isInteger(n) || n < 1 || n > 500) return said.replaceChildren(...message('critical', 'How many: 1 to 500.', 'Not made'));
      const name = label.value.trim();
      make.disabled = true;
      said.replaceChildren('Generating…');
      try {
        const result = await makeCodes({ count: n, test: test.checked, ...(name && { label: name }) });
        const created = new Date().toISOString();
        newCodes = { codes: result.codes.map((code) => ({ code, label: name || null, test: test.checked, created })), test: test.checked, note: result.note, created };
        update(result.settings, true);
        tell(`generated ${plural(n, test.checked ? 'test code' : 'enrolment code')}${name ? ` labelled "${name}"` : ''}.`);
      } catch (err) {
        make.disabled = false;
        said.replaceChildren(...message('critical', err.message, 'Not made'));
      }
    }

    const unused = settings.unused_codes;
    return el('div', {},
      el('h3', {}, 'Enrolment codes'),
      el('div', { class: 'tiles' },
        tile(settings.codes.issued, 'issued'), tile(settings.codes.unused, 'unused'), tile(settings.codes.enrolled, 'enrolled'),
        tile(settings.codes.withdrawn, 'withdrawn'), tile(settings.codes.test, 'test codes')),
      el('form', { class: 'esm-form', novalidate: true, onsubmit: generate },
        el('div', { class: 'form-grid' },
          field('How many', count, 'One per participant, single use'),
          field('Label (optional)', label, 'Kept with the codes, to tell batches apart')),
        el('label', { class: 'check' }, test, el('span', {}, 'Test codes: sessions run the preview and are saved as test data')),
        el('div', { class: 'form-actions' }, make, said)),
      newCodes
        ? el('div', { class: 'new-codes' },
            el('p', {}, status_('good', plural(newCodes.codes.length, newCodes.test ? 'new test code' : 'new code')), ' ', el('span', { class: 'muted' }, newCodes.note)),
            codeActions(newCodes.codes, `esm-codes-${newCodes.test ? 'test-' : ''}${newCodes.created.slice(0, 10)}`))
        : null,
      unused.length
        ? el('details', { class: 'technical' },
            el('summary', {}, `Unused codes (${unused.length}${unused.length === 500 ? ', newest' : ''})`),
            el('div', { class: 'scroll' }, el('table', { class: 'grid' },
              el('thead', {}, el('tr', {}, ['Code', 'Label', 'Made'].map((h) => el('th', {}, h)))),
              el('tbody', {}, unused.map((c) => el('tr', {},
                el('td', { class: 'mono' }, c.code, c.test ? el('span', { class: 'muted' }, ' · test') : null),
                el('td', {}, c.label ?? el('span', { class: 'muted' }, '–')),
                el('td', {}, date(c.created))))))),
            codeActions(unused, 'esm-unused-codes'))
        : null,
      el('p', { class: 'muted' }, 'Participants install ', el('a', { href: 'https://apps.apple.com/au/app/metaforge-live/id6758686932', target: '_blank', rel: 'noopener' }, 'MetaForge Live'), ' (iPhone, App Store) or MetaForge EMA (Android, Google Play) and enter their code. Codes given out by an intake study or intake survey are not listed here.'));
  }

  function qualtricsSection(setup) {
    return el('details', { class: 'technical' },
      el('summary', {}, 'Set up the survey for the app (required)'),
      el('ol', { class: 'steps' }, setup.steps.map((s) => el('li', {}, s))),
      el('h3', {}, 'Web Service URL'),
      copyRow(setup.web_service_url),
      el('h3', {}, 'Web Service query parameters'),
      el('table', { class: 'grid' }, el('tbody', {}, Object.entries(setup.web_service_query_parameters).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'mono' }, v))))),
      el('h3', {}, 'Last-page JavaScript'),
      el('pre', {}, setup.last_page_javascript),
      el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(setup.last_page_javascript)) ? 'Copied' : 'Select it above'; } }, 'Copy JavaScript'),
      el('p', { class: 'muted' }, setup.note));
  }


  const paramTable = (params) => el('table', { class: 'grid' }, el('tbody', {}, Object.entries(params).map(([k, v]) => el('tr', {}, el('td', { class: 'mono' }, k), el('td', { class: 'mono' }, v)))));

  // Branch logic on session counts: a Web Service step at the start of the survey, then Branch elements.
  function sessionInfoSection(info) {
    return el('details', { class: 'technical' },
      el('summary', {}, 'Show blocks only in some sessions (optional)'),
      el('p', {}, info.purpose),
      el('ol', { class: 'steps' }, info.steps.map((s) => el('li', {}, s))),
      el('h3', {}, 'Web Service URL'),
      copyRow(info.web_service_url),
      el('h3', {}, 'Query parameters'),
      paramTable(info.web_service_query_parameters),
      el('h3', {}, 'Values you can map to embedded data'),
      paramTable(info.fields),
      el('h3', {}, 'Branch conditions'),
      el('table', { class: 'grid' },
        el('thead', {}, el('tr', {}, el('th', {}, 'To show a block'), el('th', {}, 'Branch: If Embedded Data…'))),
        el('tbody', {}, info.branch_examples.map((b) => el('tr', {}, el('td', {}, b.show), el('td', { class: 'mono' }, b.condition))))),
      el('p', { class: 'muted' }, info.note));
  }

  // Codes from a Qualtrics intake survey: fetched on demand, since it creates the study's intake secret.
  function intakeSection() {
    const box = el('div', {});
    const load = el('button', { class: 'btn', type: 'button' }, 'Show the intake survey setup');
    load.addEventListener('click', async () => {
      load.disabled = true;
      try {
        const setup = await intakeSetup();
        load.hidden = true;
        box.replaceChildren(
          el('ol', { class: 'steps' }, setup.steps.map((s) => el('li', {}, s))),
          el('h3', {}, 'Web Service URL'),
          copyRow(setup.web_service_url),
          el('h3', {}, 'Query parameters'),
          paramTable(setup.web_service_query_parameters),
          el('h3', {}, 'Optional parameters'),
          paramTable(setup.optional_query_parameters),
          el('h3', {}, 'Suggested text for the participant'),
          el('pre', { class: 'wrap' }, setup.suggested_instructions),
          el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(setup.suggested_instructions)) ? 'Copied' : 'Select it above'; } }, 'Copy text'),
          el('p', { class: 'muted' }, setup.note));
        resized();
      } catch (err) {
        load.disabled = false;
        box.replaceChildren(el('p', {}, ...message('critical', err.message, 'Failed')));
      }
    });
    return el('details', { class: 'technical' },
      el('summary', {}, 'Give out codes from a Qualtrics intake survey (optional)'),
      el('p', {}, 'Instead of sending codes yourself, a separate Qualtrics survey (consent, baseline questions) can give each respondent their own code at the end. ' +
        'Qualtrics asks Second Order for a code with a Web Service step and shows it on the last page.'),
      box.childNodes.length ? null : el('div', {}, load),
      box);
  }

  // Who enrolled and how many surveys each completed.
  function statusSection() {
    const box = el('div', {});
    const show = async (button) => {
      button.disabled = true;
      try {
        const st = await status();
        const rows = st.participants;
        const csv = ['participant,code,label,test,platform,enrolled,ends,sessions_completed,compliance,last_session',
          ...rows.map((p) => [p.participant_id, p.code, p.label ?? p.from_qualtrics_response ?? '', p.test ? 'yes' : '', p.platform ?? '', p.enrolled, p.ends, p.sessions_completed, p.compliance ?? '', p.last_session ?? '']
            .map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(','))].join('\n') + '\n';
        box.replaceChildren(
          rows.length
            ? el('div', { class: 'scroll' }, el('table', { class: 'grid' },
                el('thead', {}, el('tr', {}, ['Participant', 'Code', 'Phone', 'Enrolled', 'Surveys', 'Compliance', 'Last survey'].map((h) => el('th', {}, h)))),
                el('tbody', {}, rows.map((p) => el('tr', {},
                  el('td', { class: 'mono' }, p.participant_id, p.test ? el('span', { class: 'muted' }, ' · test') : null),
                  el('td', {}, el('span', { class: 'mono' }, p.code), p.label ? el('small', { class: 'muted', style: 'display:block' }, p.label) : null),
                  el('td', {}, p.platform ?? '–'),
                  el('td', {}, date(p.enrolled)),
                  el('td', {}, String(p.sessions_completed)),
                  el('td', {}, p.compliance != null ? `${Math.round(p.compliance * 100)}%` : '–'),
                  el('td', {}, p.last_session ? date(p.last_session) : '–'))))))
            : el('p', { class: 'muted' }, 'Nobody has enrolled yet.'),
          el('div', { class: 'chips' },
            el('button', { class: 'btn', type: 'button', onclick: (e) => show(e.target) }, 'Refresh'),
            download && rows.length ? el('button', { class: 'btn', type: 'button', onclick: () => download('esm-participants.csv', 'text/csv', csv).catch(() => {}) }, 'Download CSV') : null),
          el('p', { class: 'muted' }, 'Participant is the ID the app sends to Qualtrics as the participant embedded data, so rows match your responses. ' +
            'Compliance is completed surveys over prompts sent so far (approximate). Test codes are included and marked.'));
        resized();
      } catch (err) {
        button.disabled = false;
        box.replaceChildren(el('p', {}, ...message('critical', err.message, 'Failed')));
      }
    };
    const first = el('button', { class: 'btn', type: 'button' }, 'Show participants');
    first.addEventListener('click', () => show(first));
    box.append(first);
    return el('div', {}, el('h3', {}, 'Participants'), box);
  }

  function deleteSection() {
    const said = el('div', { class: 'form-message', role: 'status' });
    const button = el('button', { class: 'btn danger', type: 'button' }, 'Delete this study');
    button.addEventListener('click', async () => {
      const typed = window.prompt(`This deletes the study's settings, codes, enrolments and session counts from Second Order, and the app stops working for participants. Responses in Qualtrics are kept.\n\nType the study's app name (${settings.app_title}) to confirm.`);
      if (typed == null) return;
      if (typed.trim() !== settings.app_title) return said.replaceChildren(...message('critical', 'The name didn\'t match; nothing was deleted.', 'Not deleted'));
      button.disabled = true;
      try {
        await deleteStudy();
        container.replaceChildren(el('div', { class: 'pad' }, el('h3', {}, 'Deleted'), el('p', {}, 'The study has been deleted from Second Order. This link no longer works.')));
        resized();
      } catch (err) {
        button.disabled = false;
        said.replaceChildren(...message('critical', err.message, 'Not deleted'));
      }
    });
    return el('div', {}, el('h3', {}, 'Delete'), el('div', { class: 'form-actions' }, button, said));
  }

  // Panel only: secret links that let someone without an account edit these settings and make codes.
  function linksSection() {
    const label = el('input', { type: 'text', maxlength: 80, required: true, disabled: !editable, placeholder: 'e.g. Sam (RA)' });
    const days = el('input', { type: 'number', min: 1, max: 90, step: 1, value: 14, disabled: !editable, required: true });
    const said = el('div', { class: 'form-message', role: 'status' });
    const make = el('button', { class: 'btn primary', type: 'submit', disabled: !editable }, 'Create edit link');

    async function create(e) {
      e.preventDefault();
      const name = label.value.trim();
      const n = Number(days.value);
      if (!name) return said.replaceChildren(...message('critical', 'Say who the link is for, so you can tell links apart.', 'Not made'));
      if (!Number.isInteger(n) || n < 1 || n > 90) return said.replaceChildren(...message('critical', 'Days: 1 to 90.', 'Not made'));
      make.disabled = true;
      try {
        const result = await links.create({ label: name, days: n });
        newLink = { url: result.url, label: name };
        update(result.settings, true);
        tell(`created an ESM edit link for "${name}", valid ${plural(n, 'day')}.`);
      } catch (err) {
        make.disabled = false;
        said.replaceChildren(...message('critical', err.message, 'Not made'));
      }
    }

    async function revoke(link, button) {
      if (!window.confirm(`Revoke the edit link for "${link.label}"? It stops working at once.`)) return;
      button.disabled = true;
      try {
        if (newLink?.label === link.label) newLink = null;
        update(await links.revoke(link.id), true);
        tell(`revoked the ESM edit link for "${link.label}".`);
      } catch (err) {
        button.disabled = false;
        button.textContent = 'Failed';
        button.title = err.message;
      }
    }

    const list = settings.edit_links;
    return el('div', {},
      el('h3', {}, 'Edit links'),
      el('p', { class: 'muted' }, 'A secret link lets someone without a Second Order account change these settings, close or reopen the study and make codes, acting as you. ' +
        'Anyone who has the link can do this until it expires or you revoke it, so send it only to the person it is for.'),
      newLink
        ? el('div', { class: 'new-codes' },
            el('p', {}, status_('good', `Link for ${newLink.label}`), ' ', el('span', { class: 'muted' }, 'Copy it now: it is shown only once.')),
            copyRow(newLink.url))
        : null,
      list.length
        ? el('ul', { class: 'rows' }, list.map((link) => {
            const button = el('button', { class: 'btn', type: 'button', disabled: !editable }, 'Revoke');
            button.addEventListener('click', () => revoke(link, button));
            return el('li', {},
              el('div', { class: 'grow' },
                el('div', {}, link.label),
                el('small', {}, [`Made by ${link.created_by} ${date(link.created)}`, `expires ${date(link.expires)}`,
                  link.last_used ? `last used ${date(link.last_used)}${link.last_action ? `: ${link.last_action}` : ''}` : 'not used yet'].join(' · '))),
              button);
          }))
        : el('p', { class: 'muted' }, 'No active edit links.'),
      el('form', { class: 'esm-form', novalidate: true, onsubmit: create },
        el('div', { class: 'form-grid' },
          field('Who it is for', label),
          field('Valid for (days)', days, '1 to 90')),
        el('div', { class: 'form-actions' }, make, said)));
  }

  update(options.settings);
  return { update };
}

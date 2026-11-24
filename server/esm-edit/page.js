// The ESM edit-link page (/esm-edit/<secret>, main origin): someone without an account edits one ESM study's
// settings and makes codes with the shared form. An owner link (a self-service study) also shows participants
// and can delete the study. The secret in the URL is the only credential; every call
// sends it in the path to /api/esm-edit/<secret>.
import '../panel/panel.css';
import './page.css';
import { date, el } from '../panel/ui.js';
import { mountEsmSettings } from '../panel/esm-form.js';
import { citation, reportFooter } from './report.js';

const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
const root = document.getElementById('root');

const dark = window.matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
theme();
dark.addEventListener('change', theme);

async function api(path, body) {
  const response = await fetch(`/api/esm-edit/${encodeURIComponent(token)}${path}`, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? 'Something went wrong. Try again in a moment.');
  return data;
}

function download(filename, mimeType, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return Promise.resolve();
}

function header(title) {
  return el('div', { class: 'bar' }, el('span', { class: 'brand' }, 'Second Order'), el('span', { class: 'title' }, title));
}

function fail(message) {
  root.replaceChildren(header('ESM settings'), el('div', { class: 'page' },
    el('div', { class: 'pad' }, el('h3', {}, 'This link can\'t be used'), el('p', {}, message)),
    reportFooter('/api/esm-report')));
}

(async () => {
  let state;
  try {
    state = await api('');
  } catch (err) {
    return fail(err.message);
  }
  document.title = `${state.study.title} · ESM settings`;
  const owner = state.kind === 'owner';
  const form = el('div', {});
  root.replaceChildren(
    header(state.study.title),
    el('div', { class: 'page' },
      el('div', { class: 'pad intro' },
        owner
          ? el('p', { class: 'note' },
              el('strong', {}, 'This is your private link to this study. '),
              'Bookmark it and keep it to yourself: anyone with it can change the study. If you lose it, ask the person who gave you the sign-up key for a new one. ',
              'Saved changes are live for participants at once.')
          : el('p', { class: 'note' },
              `${state.shared_by} shared this page so you can change the ESM settings of "${state.study.title}" and make enrolment codes. `,
              'Saved changes are live for participants at once. ',
              `This link works until ${date(state.expires)}; keep it to yourself.`)),
      form,
      citation(),
      reportFooter(`/api/esm-edit/${encodeURIComponent(token)}/report`)));
  mountEsmSettings(form, {
    settings: state.settings,
    editable: true,
    save: async (changes) => {
      const r = await api('/settings', changes);
      return { settings: r.settings, warnings: r.result.warnings };
    },
    makeCodes: async (args) => {
      const r = await api('/codes', args);
      return { codes: r.result.codes, note: r.result.note, settings: r.settings };
    },
    download,
    refresh: async () => (await api('')).settings,
    intakeSetup: () => api('/intake'),
    ...(owner && {
      status: () => api('/status'),
      deleteStudy: () => api('/delete', { confirm: true }),
    }),
  });
})();

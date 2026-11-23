// Self-service sign-up (/esm/new, main origin): someone with the sign-up key sets up a Qualtrics-only ESM study
// and gets its private owner link. Nothing here needs an account.
import '../panel/panel.css';
import './page.css';
import { copy, el, status_ } from '../panel/ui.js';
import { reportFooter } from './report.js';

const root = document.getElementById('root');
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const theme = () => { document.documentElement.dataset.theme = dark.matches ? 'dark' : 'light'; };
theme();
dark.addEventListener('change', theme);
document.title = 'Set up a Qualtrics ESM study';

const show = (...content) => root.replaceChildren(header(), ...content, el('div', { class: 'page' }, reportFooter('/api/esm-report')));
const header = () => el('div', { class: 'bar' }, el('span', { class: 'brand' }, 'Second Order'), el('span', { class: 'title' }, 'Qualtrics ESM study'));
const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);

function done({ owner_url }) {
  const input = el('input', { class: 'url', readonly: true, value: owner_url, onclick: (e) => e.target.select() });
  show(el('div', { class: 'page pad' },
    el('h3', {}, 'Your study is set up'),
    el('p', {}, status_('good', 'Ready'), ' This is your private link to the study. ', el('strong', {}, 'Copy it and bookmark it now: it is shown only once.')),
    el('div', { class: 'copy-row' }, input,
      el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(owner_url, input)) ? 'Copied' : 'Selected'; } }, 'Copy')),
    el('p', { class: 'note' }, 'Anyone with the link can change your study, so keep it to yourself. If you lose it, ask the person who gave you the sign-up key for a new one.'),
    el('h3', {}, 'Next'),
    el('ol', { class: 'steps' },
      el('li', {}, 'Open your link. Under "Set up the survey for the app", add the Survey Flow steps to your Qualtrics survey and publish it.'),
      el('li', {}, 'Check the schedule (prompts per day, days, the daily window) and save.'),
      el('li', {}, 'Make a test code, enter it in the MetaForge app on your phone (', el('a', { href: 'https://apps.apple.com/au/app/metaforge-live/id6758686932', target: '_blank', rel: 'noopener' }, 'MetaForge Live'), ' on iPhone), and complete a survey: the participant table should show it.'),
      el('li', {}, 'Then make real codes, or set up a Qualtrics intake survey that gives each respondent a code.')),
    el('p', {}, el('a', { class: 'btn primary', href: owner_url }, 'Open my study'))));
}

(async () => {
  let open = false;
  try {
    open = (await (await fetch('/api/esm-signup', { cache: 'no-store' })).json()).open;
  } catch { /* shown below */ }
  if (!open) {
    return show(el('div', { class: 'page pad' }, el('h3', {}, 'Sign-up is closed'),
      el('p', {}, 'Setting up new studies is turned off at the moment. Please contact the person who sent you here.')));
  }

  const inputs = {
    key: el('input', { type: 'password', required: true, autocomplete: 'off' }),
    name: el('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'name' }),
    email: el('input', { type: 'email', required: true, maxlength: 200, autocomplete: 'email' }),
    institution: el('input', { type: 'text', maxlength: 150, autocomplete: 'organization', placeholder: 'e.g. University of Sydney' }),
    app_title: el('input', { type: 'text', required: true, maxlength: 80, placeholder: 'e.g. Daily mood study' }),
    survey_url: el('input', { type: 'url', required: true, maxlength: 500, placeholder: 'https://sydney.au1.qualtrics.com/jfe/form/SV_…' }),
  };
  const agree = el('input', { type: 'checkbox' });
  const said = el('div', { class: 'form-message', role: 'status' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Set up my study');

  async function send(e) {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(inputs).map(([k, input]) => [k, input.value.trim()]));
    if (!body.institution) delete body.institution;
    body.agree = agree.checked;
    const missing = ['key', 'name', 'email', 'app_title', 'survey_url'].find((k) => !body[k]);
    if (missing) return said.replaceChildren(status_('critical', 'Not set up'), ' Fill in every field marked as required.');
    if (!inputs.email.checkValidity()) return said.replaceChildren(status_('critical', 'Not set up'), ' Check your email address.');
    if (!agree.checked) return said.replaceChildren(status_('critical', 'Not set up'), ' Tick the box to confirm you have read how data is handled.');
    submit.disabled = true;
    said.replaceChildren('Setting up…');
    try {
      const response = await fetch('/api/esm-signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'Something went wrong. Try again in a moment.');
      done(data);
    } catch (err) {
      submit.disabled = false;
      said.replaceChildren(status_('critical', 'Not set up'), ' ', err.message);
    }
  }

  show(el('div', { class: 'page pad' },
    el('h3', {}, 'Set up a Qualtrics ESM study'),
    el('p', {}, 'Run an experience sampling study with the free MetaForge phone app (', el('a', { href: 'https://apps.apple.com/au/app/metaforge-live/id6758686932', target: '_blank', rel: 'noopener' }, 'MetaForge Live'), ' on iPhone, MetaForge EMA on Android) and a survey you build in Qualtrics. ' +
      'Participants enter a code in the app and get notifications on your schedule; each notification opens your survey. You need the sign-up key from the person who sent you here.'),
    el('form', { class: 'esm-form', novalidate: true, onsubmit: send },
      el('div', { class: 'form-grid' },
        field('Sign-up key (required)', inputs.key),
        field('Your name (required)', inputs.name),
        field('Your email (required)', inputs.email, 'Only to identify you if you lose your link'),
        field('Institution', inputs.institution)),
      el('h3', {}, 'Your study'),
      el('div', { class: 'form-grid' },
        field('Study name in the app (required)', inputs.app_title, 'What participants see')),
      el('div', { class: 'esm-form' }, field('Qualtrics survey link (required)', inputs.survey_url, 'The survey\'s anonymous link. You can add the Survey Flow steps after setting up.')),
      el('h3', {}, 'How data is handled'),
      el('ul', { class: 'steps' },
        el('li', {}, 'Survey responses go to your Qualtrics account only.'),
        el('li', {}, 'Second Order keeps what the app needs: your settings and codes, a random ID per participant, their phone model and operating system, when they enrolled, and when each survey was completed.'),
        el('li', {}, 'All of it is deleted 12 months after the study\'s last activity, or when you delete the study.'),
        el('li', {}, 'Mention this in your ethics application if it asks where participant data is stored.')),
      el('label', { class: 'check' }, agree, el('span', {}, 'I have read this and am responsible for ethics approval for my study.')),
      el('div', { class: 'form-actions' }, submit, said))));
})();

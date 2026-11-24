// "Report a problem" at the foot of the self-service ESM pages: a short private form that reaches the Second
// Order maintainers (list_feedback). `endpoint` is the page's report URL; from an owner or edit link the server
// adds which study it is, so people never need to paste their link.
import { copy, el, status_ } from '../panel/ui.js';

export function reportFooter(endpoint) {
  const summary = el('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Codes won\'t generate' });
  const details = el('textarea', { class: 'codes-text', rows: 4, maxlength: 4000, placeholder: 'What did you do, and what happened? Include any error message.' });
  const contact = el('input', { type: 'email', maxlength: 200, placeholder: 'you@university.edu' });
  const said = el('div', { class: 'form-message', role: 'status' });
  const send = el('button', { class: 'btn primary', type: 'submit' }, 'Send report');

  const form = el('form', { class: 'esm-form report-form', novalidate: true, hidden: true, onsubmit: async (e) => {
    e.preventDefault();
    if (!summary.value.trim()) return said.replaceChildren(status_('critical', 'Not sent'), ' Say in a few words what went wrong.');
    if (contact.value.trim() && !contact.checkValidity()) return said.replaceChildren(status_('critical', 'Not sent'), ' Check the email address, or leave it empty.');
    send.disabled = true;
    said.replaceChildren('Sending…');
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: summary.value.trim(), details: details.value, contact: contact.value.trim() }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? 'Something went wrong. Try again in a moment.');
      form.replaceChildren(el('p', {}, status_('good', 'Sent'), ' Thanks: the Second Order maintainers will read it', contact.value.trim() ? ' and reply by email.' : '.'));
    } catch (err) {
      send.disabled = false;
      said.replaceChildren(status_('critical', 'Not sent'), ' ', err.message);
    }
  } },
    el('h3', {}, 'Report a problem'),
    el('label', { class: 'field' }, el('span', {}, 'What went wrong'), summary),
    el('label', { class: 'field' }, el('span', {}, 'Details'), details),
    el('label', { class: 'field' }, el('span', {}, 'Your email (optional)'), contact, el('small', {}, 'Only if you would like a reply.')),
    el('p', { class: 'muted' }, 'Please don\'t paste your private link or participant codes: we can already tell which study this is about.'),
    el('div', { class: 'form-actions' }, send, said));

  const toggle = el('button', { class: 'link', type: 'button', onclick: () => {
    form.hidden = !form.hidden;
    if (!form.hidden) summary.focus();
  } }, 'Report a problem');

  return el('footer', { class: 'pad report' }, el('p', { class: 'muted' }, 'Something not working? ', toggle), form);
}

const CITATION = 'Double, K. S. (preprint). Second Order and MetaForge: An AI-Native Platform for Online Behavioural Experiments and ' +
  'Ecological Momentary Assessment. Retrieved from osf.io/preprints/psyarxiv/vh7uk_v1';

/** How to cite the platform, at the foot of the self-service pages. */
export function citation() {
  return el('section', { class: 'pad cite' },
    el('h3', {}, 'How to cite'),
    el('p', { class: 'muted' }, 'If you publish work that used Second Order or the MetaForge app, please cite:'),
    el('p', { class: 'cite-text' },
      'Double, K. S. (preprint). ',
      el('em', {}, 'Second Order and MetaForge: An AI-Native Platform for Online Behavioural Experiments and Ecological Momentary Assessment'),
      '. Retrieved from ',
      el('a', { href: 'https://osf.io/preprints/psyarxiv/vh7uk_v1', target: '_blank', rel: 'noopener' }, 'osf.io/preprints/psyarxiv/vh7uk_v1')),
    el('button', { class: 'btn', type: 'button', onclick: async (e) => { e.target.textContent = (await copy(CITATION)) ? 'Copied' : 'Select it above'; } }, 'Copy citation'));
}

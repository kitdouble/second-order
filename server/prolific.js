// Prolific, through its API with the lab's one token. A Second Order study gets a Prolific draft (with its own
// participant link and completion code), which is launched and topped up with places. Anything that spends
// money is two-step: the first call returns a quote and a confirm code, nothing is spent, and only a second
// call with that code (after the researcher has said yes) does it. A launch can be scheduled for later
// (publish_at); the money counts as spent once it is scheduled, and is given back if the schedule is cancelled. Spending is capped per study and per
// researcher per calendar month; admins are exempt. Every spend is recorded in prolific_spend.
import { randomBytes } from 'node:crypto';
import { db, hash, newToken, now } from './db.js';
import { closeLink, createLink, findStudy, iso, linkUrl, StudyError } from './studies.js';
import { currentRevision } from './live.js';
import { checkLaunch } from './monitor.js';
import { PROLIFIC_GBP_PER_HOUR } from './lib/context.js';

db.exec(`
  -- A Prolific study made for a Second Order study, with the participant link it sends people to.
  CREATE TABLE IF NOT EXISTS prolific_studies (
    prolific_id      TEXT PRIMARY KEY,
    study_id         TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
    link_token       TEXT NOT NULL REFERENCES links(token),
    completion_code  TEXT NOT NULL,
    reward           INTEGER NOT NULL,          -- per participant, in pence
    minutes          REAL NOT NULL,
    created_by       TEXT NOT NULL REFERENCES users(id),
    created_at       INTEGER NOT NULL,
    launched_at      INTEGER
  );

  -- Money committed on Prolific, in pence including Prolific's fees and VAT.
  CREATE TABLE IF NOT EXISTS prolific_spend (
    id           INTEGER PRIMARY KEY,
    prolific_id  TEXT NOT NULL,
    study_id     TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id),
    action       TEXT NOT NULL CHECK (action IN ('launch', 'places', 'cancel')),  -- cancel: a scheduled launch, negative cost
    places       INTEGER NOT NULL,
    cost         INTEGER NOT NULL,
    at           INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prolific_spend_study ON prolific_spend(study_id);
  CREATE INDEX IF NOT EXISTS prolific_spend_user ON prolific_spend(user_id, at);

  -- Quotes waiting for the researcher's yes. The confirm code is stored hashed.
  CREATE TABLE IF NOT EXISTS prolific_quotes (
    token_hash   TEXT PRIMARY KEY,
    prolific_id  TEXT NOT NULL,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action       TEXT NOT NULL,
    places       INTEGER NOT NULL,
    cost         INTEGER NOT NULL,
    publish_at   INTEGER,                   -- scheduled launch time, null for now
    expires_at   INTEGER NOT NULL
  );
`);

const env = (name, fallback) => process.env[name] || fallback;
const API = () => env('PROLIFIC_API_URL', 'https://api.prolific.com/api/v1').replace(/\/$/, '');
const CAPS = () => ({
  study: Math.round(Number(env('PROLIFIC_STUDY_CAP_GBP', 150)) * 100),
  userMonth: Math.round(Number(env('PROLIFIC_USER_MONTHLY_CAP_GBP', 300)) * 100),
});
const QUOTE_MINUTES = 15;

export const gbp = (pence) => `£${(pence / 100).toFixed(2)}`;

// The lab's standard advert for HREC 2022/796; always US and UK residents, balanced male and female.
const ADVERT = {
  name: 'Metacognition and Cognitive Performance',
  description: 'In this study, you will be asked to perform a series of computerised cognitive tasks and answer some survey questionnaires about yourself.',
};
const COUNTRIES = ['United States', 'United Kingdom'];

/* ---------- API ---------- */

async function call(method, path, body) {
  const token = process.env.PROLIFIC_API_TOKEN;
  if (!token) throw new StudyError('Prolific isn\'t connected on this server (PROLIFIC_API_TOKEN is not set). Ask an admin.', { platform: true });
  let res;
  try {
    res = await fetch(`${API()}${path}`, {
      method,
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new StudyError(`Couldn't reach Prolific: ${err.message}`, { platform: true });
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const detail = json ? JSON.stringify(json.error ?? json).slice(0, 800) : text.slice(0, 300);
    throw new StudyError(`Prolific refused ${method} ${path} (${res.status}): ${detail}`, { platform: res.status >= 500 || res.status === 401 });
  }
  return json;
}

// Filter choice ids differ from the labels people know, so look them up by label.
async function standardFilters() {
  const { results = [] } = await call('GET', '/filters/');
  const select = (match) => results.find((f) => f.type === 'select' && match(f));
  const choiceIds = (filter, labels) => labels.map((label) => {
    const id = Object.entries(filter.choices ?? {}).find(([, l]) => l === label || l === `${label} of America`)?.[0];
    if (id === undefined) throw new StudyError(`Prolific's "${filter.title}" filter has no choice "${label}".`, { platform: true });
    return id;
  });

  const country = select((f) => f.filter_id === 'current-country-of-residence') ?? select((f) => /current country of residence/i.test(f.title ?? ''));
  const sex = select((f) => f.filter_id === 'sex');
  if (!country || !sex) throw new StudyError('Couldn\'t find Prolific\'s country of residence or sex filter.', { platform: true });
  const [male, female] = choiceIds(sex, ['Male', 'Female']);
  return [
    { filter_id: country.filter_id, selected_values: choiceIds(country, COUNTRIES) },
    { filter_id: sex.filter_id, selected_values: [male, female], weightings: { [male]: 1, [female]: 1 } },
  ];
}

const PROLIFIC_ID = /^[0-9a-f]{24}$/;

// Who mustn't take part: people from earlier Prolific studies (by Prolific id, or every Prolific study of
// a Second Order study) and individual Prolific participant ids.
function exclusionFilters(user, { exclude_studies = [], exclude_participants = [] }) {
  const studyIds = new Set();
  for (const ref of exclude_studies) {
    if (PROLIFIC_ID.test(ref)) { studyIds.add(ref); continue; }
    const study = findStudy(user, ref, 'view');
    const ours = db.prepare('SELECT prolific_id FROM prolific_studies WHERE study_id = ?').all(study.id);
    if (!ours.length) throw new StudyError(`"${study.title}" has no Prolific studies to exclude. Give Prolific study ids instead (list_prolific_studies).`);
    for (const { prolific_id } of ours) studyIds.add(prolific_id);
  }
  const bad = exclude_participants.filter((id) => !PROLIFIC_ID.test(id));
  if (bad.length) throw new StudyError(`Not Prolific participant ids: ${bad.join(', ')}`);
  return [
    ...(studyIds.size ? [{ filter_id: 'previous_studies_blocklist', selected_values: [...studyIds] }] : []),
    ...(exclude_participants.length ? [{ filter_id: 'custom_blocklist', selected_values: [...new Set(exclude_participants)] }] : []),
  ];
}

/** The lab's Prolific studies that can be excluded (Prolific's list of the most recent 200), optionally matching a search. */
export async function listProlificStudies({ search } = {}) {
  const { results = [] } = await call('GET', '/filters/');
  const choices = Object.entries(results.find((f) => f.filter_id === 'previous_studies_blocklist')?.choices ?? {});
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const ours = new Map(db.prepare('SELECT prolific_id, study_id FROM prolific_studies').all().map((r) => [r.prolific_id, r.study_id]));
  const matches = choices.filter(([, title]) => words.every((w) => title.toLowerCase().includes(w)));
  return {
    shown: Math.min(matches.length, 100), matching: matches.length, of: choices.length,
    studies: matches.slice(0, 100).map(([prolific_id, title]) => ({ prolific_id, title, second_order_study: ours.get(prolific_id) ?? null })),
  };
}

// Prolific's own total (reward plus fees and VAT) for this many places.
async function costOf(reward, places) {
  const { total_cost } = await call('POST', '/study-cost-calculator/', { reward, total_available_places: places });
  if (!(Number(total_cost) > 0)) throw new StudyError('Prolific didn\'t return a cost for this study.', { platform: true });
  return Math.ceil(Number(total_cost));
}

/* ---------- Reading the experiment ---------- */

// The length stated in consent({ minutes }), which also sets the pay participants are promised.
function statedMinutes(code) {
  return Number(code.match(/consent\(\s*\{[^}]*minutes\s*:\s*(\d+(?:\.\d+)?)/)?.[1]) || null;
}

// deviceCheck() allows computers unless told otherwise; without it, any device can take part.
const DEVICE_NAMES = { computer: 'desktop', tablet: 'tablet', phone: 'mobile' };
function prolificDevices(code) {
  const call = code.match(/deviceCheck\(([^)]*)\)/);
  if (!call) return null;
  const listed = call[1].match(/devices\s*:\s*\[([^\]]*)\]/)?.[1];
  const devices = listed ? [...listed.matchAll(/["'](\w+)["']/g)].map((m) => m[1]) : ['computer'];
  return devices.map((d) => DEVICE_NAMES[d]).filter(Boolean);
}

/* ---------- Spending ---------- */

const monthStart = (at = now()) => { const d = new Date(at); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
const spentOnStudy = (studyId) => db.prepare('SELECT COALESCE(SUM(cost), 0) AS p FROM prolific_spend WHERE study_id = ?').get(studyId).p;
const spentByUser = (userId) => db.prepare('SELECT COALESCE(SUM(cost), 0) AS p FROM prolific_spend WHERE user_id = ? AND at >= ?').get(userId, monthStart()).p;

function budget(user, studyId) {
  const caps = CAPS();
  const study = spentOnStudy(studyId);
  const month = spentByUser(user.id);
  return {
    exempt: user.role === 'admin',
    spent_on_study: gbp(study),
    spent_by_you_this_month: gbp(month),
    ...(user.role === 'admin'
      ? { caps: 'none (admin)' }
      : { left_for_study: gbp(Math.max(0, caps.study - study)), left_for_you_this_month: gbp(Math.max(0, caps.userMonth - month)),
          caps: `${gbp(caps.study)} per study, ${gbp(caps.userMonth)} per researcher per month` }),
  };
}

function checkCaps(user, studyId, cost) {
  if (user.role === 'admin') return;
  const caps = CAPS();
  const study = spentOnStudy(studyId);
  const month = spentByUser(user.id);
  if (study + cost > caps.study) {
    throw new StudyError(`That would take this study's Prolific spending to ${gbp(study + cost)}, over the ${gbp(caps.study)} per-study cap ` +
      `(${gbp(study)} spent so far). Use fewer places, or ask an admin to run it.`);
  }
  if (month + cost > caps.userMonth) {
    throw new StudyError(`That would take your Prolific spending this month to ${gbp(month + cost)}, over the ${gbp(caps.userMonth)} monthly cap ` +
      `(${gbp(month)} spent so far). Use fewer places, or ask an admin to run it.`);
  }
}

/* ---------- Drafts ---------- */

function findProlific(user, studyId, prolificId) {
  const study = findStudy(user, studyId, 'edit');
  const rows = db.prepare('SELECT * FROM prolific_studies WHERE study_id = ? ORDER BY created_at DESC').all(study.id);
  const row = prolificId ? rows.find((r) => r.prolific_id === prolificId) : rows[0];
  if (!row) {
    throw new StudyError(prolificId
      ? `Prolific study ${prolificId} doesn't belong to "${study.title}". Use prolific_status.`
      : `"${study.title}" has no Prolific study yet. Create one with create_prolific_draft.`);
  }
  if (!prolificId && rows.length > 1) {
    throw new StudyError(`"${study.title}" has ${rows.length} Prolific studies; say which with prolific_id (see prolific_status).`);
  }
  return { study, row };
}

export async function createDraft(user, studyId, { places, label, name, description, exclude_studies = [], exclude_participants = [] }) {
  const study = findStudy(user, studyId, 'edit');
  const v = currentRevision(study.id);
  if (!v) throw new StudyError('Write the experiment (update_experiment) before making a Prolific study.');
  const minutes = statedMinutes(v.code);
  if (!minutes) {
    throw new StudyError('The experiment has no consent({ minutes }), so there is no stated length or pay. Add the consent block first: ' +
      'Prolific pay is set from it at the lab rate.');
  }
  const reward = Math.ceil((minutes / 60) * PROLIFIC_GBP_PER_HOUR * 100 - 1e-9);
  const devices = prolificDevices(v.code);
  const exclusions = exclusionFilters(user, { exclude_studies, exclude_participants });
  const filters = [...await standardFilters(), ...exclusions];

  const code = randomBytes(6).toString('hex').toUpperCase();
  const link = createLink(user, study.id, {
    recruitment: 'prolific',
    completion_url: `https://app.prolific.com/submissions/complete?cc=${code}`,
    label: label ?? 'Prolific',
  });
  const body = {
    name: name ?? ADVERT.name,
    internal_name: `${study.title} (${study.id})`,
    description: `<p>${description ?? ADVERT.description}</p>`,
    external_study_url: link.url,
    prolific_id_option: 'url_parameters',
    completion_codes: [{ code, code_type: 'COMPLETED', actor: 'participant', actions: [{ action: 'AUTOMATICALLY_APPROVE' }] }],
    total_available_places: places,
    estimated_completion_time: Math.ceil(minutes),
    reward,
    ...(devices && { device_compatibility: devices }),
    filters,
    study_type: 'QUOTA', // needed for the weighted (balanced) sex filter
    ...(process.env.PROLIFIC_PROJECT_ID && { project: process.env.PROLIFIC_PROJECT_ID }),
  };
  let created;
  try {
    created = await call('POST', '/studies/', body);
  } catch (err) {
    closeLink(user, study.id, link.url);
    throw err;
  }
  db.prepare(
    `INSERT INTO prolific_studies (prolific_id, study_id, link_token, completion_code, reward, minutes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(created.id, study.id, link.url.match(/\/s\/([A-Za-z0-9_-]+)/)[1], code, reward, minutes, user.id, now());

  return {
    prolific_id: created.id,
    status: created.status ?? 'UNPUBLISHED',
    title: body.name,
    description: ADVERT.description === (description ?? ADVERT.description) ? 'lab default' : body.description,
    places,
    minutes: Math.ceil(minutes),
    reward_per_participant: gbp(reward),
    devices: devices ?? 'any (the experiment has no deviceCheck)',
    sample: 'US and UK residents, balanced male and female',
    excluded: {
      previous_studies: exclusions.find((f) => f.filter_id === 'previous_studies_blocklist')?.selected_values ?? [],
      participants: exclusions.find((f) => f.filter_id === 'custom_blocklist')?.selected_values.length ?? 0,
    },
    participant_link: link.url,
    completion_url: `https://app.prolific.com/submissions/complete?cc=${code}`,
    review_on_prolific: `https://app.prolific.com/researcher/workspaces/studies/${created.id}`,
    budget: budget(user, study.id),
    next: 'Nothing has been spent. When the researcher wants to go live, call launch_prolific_study for a quote.',
  };
}

/* ---------- Quotes and confirmed spending ---------- */

function issueQuote(user, row, action, places, cost, publishAt = null) {
  const code = newToken().slice(0, 10);
  db.prepare('INSERT INTO prolific_quotes (token_hash, prolific_id, user_id, action, places, cost, publish_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(hash(code), row.prolific_id, user.id, action, places, cost, publishAt, now() + QUOTE_MINUTES * 60_000);
  return code;
}

function takeQuote(user, row, action, confirmCode) {
  const quote = db.prepare('SELECT * FROM prolific_quotes WHERE token_hash = ?').get(hash(String(confirmCode)));
  if (!quote || quote.user_id !== user.id || quote.prolific_id !== row.prolific_id || quote.action !== action) {
    throw new StudyError('That confirm code doesn\'t match this quote. Ask for a new quote (call again without confirm_code).');
  }
  if (quote.expires_at <= now()) throw new StudyError('That quote has expired. Ask for a new one (call again without confirm_code).');
  db.prepare('DELETE FROM prolific_quotes WHERE token_hash = ?').run(quote.token_hash);
  return quote;
}

const record = (user, row, action, places, cost) => db.prepare(
  'INSERT INTO prolific_spend (prolific_id, study_id, user_id, action, places, cost, at) VALUES (?, ?, ?, ?, ?, ?, ?)'
).run(row.prolific_id, row.study_id, user.id, action, places, cost, now());

const ASK = 'Nothing has been spent. Show the researcher this quote and ask them to confirm. Only if they clearly say yes, call again ' +
  `with confirm_code. The code works once, for this quote only, for ${QUOTE_MINUTES} minutes.`;

// The lab is in Sydney; participants are mostly in the US and UK, so launches are often scheduled.
const when = (ms) => ({
  sydney: new Date(ms).toLocaleString('en-AU', { timeZone: 'Australia/Sydney', dateStyle: 'full', timeStyle: 'short' }),
  london: new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'full', timeStyle: 'short' }),
  new_york: new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' }),
  utc: new Date(ms).toISOString(),
});

function parsePublishAt(publishAt) {
  if (!publishAt) return null;
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(publishAt)) {
    throw new StudyError('publish_at needs a time zone, e.g. "2026-10-08T19:00:00+11:00" (Sydney summer time) or "2026-10-08T08:00:00Z".');
  }
  const ms = Date.parse(publishAt);
  if (!Number.isFinite(ms)) throw new StudyError(`"${publishAt}" isn't a date and time Second Order understands; use ISO 8601 with a time zone.`);
  if (ms < now() + 5 * 60_000) throw new StudyError('publish_at must be at least 5 minutes from now. To launch straight away, leave it out.');
  if (ms > now() + 30 * 24 * 60 * 60_000) throw new StudyError('publish_at can be at most 30 days ahead.');
  return ms;
}

export async function launch(user, studyId, { prolific_id, publish_at, confirm_code }) {
  const { study, row } = findProlific(user, studyId, prolific_id);
  const publishAt = confirm_code ? null : parsePublishAt(publish_at);
  const remote = await call('GET', `/studies/${row.prolific_id}/`);
  if (remote.status !== 'UNPUBLISHED') throw new StudyError(`This Prolific study is already ${remote.status}. To recruit more, use add_prolific_places.`);
  const places = Number(remote.total_available_places);
  const cost = await costOf(row.reward, places);

  if (!confirm_code) {
    const link = db.prepare('SELECT * FROM links WHERE token = ?').get(row.link_token);
    if (link.closed_at) throw new StudyError('Its participant link has been closed, so participants couldn\'t take part. Make a new draft.');
    const check = await checkLaunch(user, study.id, { recruitment: 'prolific', completion_url: link.completion_url });
    const fails = check.checks.filter((c) => c.status === 'fail');
    if (fails.length) throw new StudyError(`Not ready to launch: ${fails.map((c) => `${c.check}: ${c.detail}`).join(' ')}`);
    checkCaps(user, study.id, cost);
    return {
      quote: {
        study: study.title,
        prolific_title: remote.name,
        places,
        minutes: remote.estimated_completion_time,
        reward_per_participant: gbp(row.reward),
        total_cost: `${gbp(cost)} (including Prolific's fees and VAT)`,
        sample: 'US and UK residents, balanced male and female',
        devices: remote.device_compatibility ?? 'any',
        goes_live: publishAt ? when(publishAt) : 'straight away',
      },
      launch_check_warnings: check.checks.filter((c) => c.status === 'warn').map((c) => `${c.check}: ${c.detail}`),
      budget_before: budget(user, study.id),
      confirm_code: issueQuote(user, row, 'launch', places, cost, publishAt),
      note: ASK,
    };
  }

  const quote = takeQuote(user, row, 'launch', confirm_code);
  if (quote.places !== places || quote.cost !== cost) {
    throw new StudyError(`The study changed since the quote (now ${places} places, ${gbp(cost)}). Ask for a new quote.`);
  }
  if (quote.publish_at && quote.publish_at < now() + 60_000) {
    throw new StudyError('The scheduled time in that quote is now too close or past. Ask for a new quote with a later publish_at.');
  }
  checkCaps(user, study.id, cost);
  await call('POST', `/studies/${row.prolific_id}/transition/`, quote.publish_at
    ? { action: 'SCHEDULE_PUBLISH', publish_at: new Date(quote.publish_at).toISOString() }
    : { action: 'PUBLISH' });
  record(user, row, 'launch', places, cost);
  db.prepare('UPDATE prolific_studies SET launched_at = ? WHERE prolific_id = ?').run(quote.publish_at ?? now(), row.prolific_id);
  return {
    [quote.publish_at ? 'scheduled' : 'launched']: `${remote.name}: ${places} places, ${gbp(cost)} committed.`,
    ...(quote.publish_at && { goes_live: when(quote.publish_at), cancel: 'set_prolific_status with action cancel_schedule (gives the money back to the budget).' }),
    budget: budget(user, study.id),
    next: 'Watch it with prolific_status and study_status.',
  };
}

export async function addPlaces(user, studyId, { prolific_id, places, confirm_code }) {
  const { study, row } = findProlific(user, studyId, prolific_id);
  const remote = await call('GET', `/studies/${row.prolific_id}/`);
  const total = Number(remote.total_available_places) + places;

  // Before launch, places cost nothing yet: the launch quote covers them.
  if (remote.status === 'UNPUBLISHED') {
    await call('PATCH', `/studies/${row.prolific_id}/`, { total_available_places: total });
    return { places: total, note: 'The study isn\'t launched, so nothing was spent. The launch quote will include these places.' };
  }
  if (!['SCHEDULED', 'ACTIVE', 'PAUSED', 'AWAITING REVIEW', 'COMPLETED'].includes(remote.status)) {
    throw new StudyError(`Places can't be added to a ${remote.status} study.`);
  }
  const cost = await costOf(row.reward, places);

  if (!confirm_code) {
    checkCaps(user, study.id, cost);
    return {
      quote: {
        study: study.title,
        prolific_title: remote.name,
        status: remote.status,
        places_now: Number(remote.total_available_places),
        adding: places,
        places_after: total,
        reward_per_participant: gbp(row.reward),
        cost: `${gbp(cost)} (including Prolific's fees and VAT)`,
      },
      budget_before: budget(user, study.id),
      confirm_code: issueQuote(user, row, 'places', places, cost),
      note: ASK,
    };
  }

  const quote = takeQuote(user, row, 'places', confirm_code);
  if (quote.places !== places || quote.cost !== cost) throw new StudyError('That doesn\'t match the quote. Ask for a new quote.');
  checkCaps(user, study.id, cost);
  await call('PATCH', `/studies/${row.prolific_id}/`, { total_available_places: total });
  record(user, row, 'places', places, cost);
  return { added: places, places_now: total, committed: gbp(cost), budget: budget(user, study.id) };
}

/* ---------- Status and pausing ---------- */

export async function prolificStatus(user, studyId) {
  const study = findStudy(user, studyId, 'view');
  const rows = db.prepare('SELECT * FROM prolific_studies WHERE study_id = ? ORDER BY created_at').all(study.id);
  const studies = await Promise.all(rows.map(async (row) => {
    const link = db.prepare('SELECT * FROM links WHERE token = ?').get(row.link_token);
    const spent = db.prepare('SELECT COALESCE(SUM(cost), 0) AS p FROM prolific_spend WHERE prolific_id = ?').get(row.prolific_id).p;
    let remote;
    try { remote = await call('GET', `/studies/${row.prolific_id}/`); } catch (err) { remote = { error: err.message }; }
    return {
      prolific_id: row.prolific_id,
      status: remote.status ?? remote.error,
      title: remote.name,
      places: remote.total_available_places,
      places_taken: remote.places_taken,
      submissions: remote.number_of_submissions,
      reward_per_participant: gbp(row.reward),
      minutes: row.minutes,
      spent: gbp(spent),
      created: iso(row.created_at),
      launched: iso(row.launched_at),
      participant_link: linkUrl(link),
      completion_url: link.completion_url,
      completion_code: row.completion_code,
      excluded_previous_studies: (remote.filters ?? []).find((f) => f.filter_id === 'previous_studies_blocklist')?.selected_values ?? [],
      link_status: link.closed_at ? 'closed' : 'open',
    };
  }));
  return { study: study.title, prolific_studies: studies, budget: budget(user, study.id) };
}

const TRANSITIONS = { pause: 'PAUSE', resume: 'START', stop: 'STOP', cancel_schedule: 'CANCEL_PUBLISH' };

export async function setProlificStatus(user, studyId, { prolific_id, action, researcher_confirmed }) {
  const { study, row } = findProlific(user, studyId, prolific_id);
  if (action === 'stop' && researcher_confirmed !== true) {
    throw new StudyError('Stopping ends recruitment for good. Confirm with the researcher first, then set researcher_confirmed.');
  }
  const result = await call('POST', `/studies/${row.prolific_id}/transition/`, { action: TRANSITIONS[action] });
  if (action !== 'cancel_schedule') return { prolific_id: row.prolific_id, status: result?.status ?? TRANSITIONS[action] };

  // Back to a draft: what it committed no longer counts, and launching again quotes it afresh.
  const committed = db.prepare('SELECT COALESCE(SUM(cost), 0) AS p FROM prolific_spend WHERE prolific_id = ?').get(row.prolific_id).p;
  if (committed > 0) {
    db.prepare(
      `INSERT INTO prolific_spend (prolific_id, study_id, user_id, action, places, cost, at)
       SELECT prolific_id, study_id, user_id, 'cancel', -places, -cost, ? FROM prolific_spend WHERE prolific_id = ? AND action != 'cancel'`
    ).run(now(), row.prolific_id);
  }
  db.prepare('UPDATE prolific_studies SET launched_at = NULL WHERE prolific_id = ?').run(row.prolific_id);
  return { prolific_id: row.prolific_id, status: result?.status ?? 'UNPUBLISHED', returned_to_budget: gbp(committed), budget: budget(user, study.id) };
}

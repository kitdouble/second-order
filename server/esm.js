// ESM / EMA studies through the MetaForge phone apps ("MetaForge Live" on iPhone, "MetaForge EMA" on
// Android). The apps were built for metaforge.live; they send codes starting "SO-" here instead, and
// speak the same four endpoints (emaValidateCode, emaEnroll, emaGetConfig, emaRecordSession) on the
// run origin. Each app session opens the study's ESM link with ?participant=…&sessionNumber=…&
// notificationTime=…&timezone=…, runs the live experiment like any other run, and counts once it finishes.
// A study can instead point the app at a survey hosted in Qualtrics (survey_url): the survey reads those
// parameters as embedded data and tells /esm/done when a session is finished, and the sessions are counted there.
import express from 'express';
import { randomBytes, randomInt } from 'node:crypto';
import { db, newToken, now, DAY } from './db.js';
import { config } from './config.js';
import { currentRevision } from './live.js';
import { findStudy, iso, roleIn, StudyError } from './studies.js';

/* ---------- Schedules ---------- */

// What the apps understand (MetaForge's ScheduleParams), with MetaForge's defaults.
export const DEFAULT_SCHEDULE = {
  scheduleType: 'random',
  notificationsPerDay: 4,
  studyDuration: 7,
  startTime: '09:00',
  endTime: '20:00',
  minInterval: 60,
  expirationMinutes: 30,
  showNextNotification: false,
  allowRescheduleAndFullSchedule: false,
  delayNotifications: false,
  startWithSurvey: false,
  oneSurveyPerDay: false,
  eventContingent: false,
};

// MCP field names (snake_case) to the apps' names.
const FIELDS = {
  schedule_type: 'scheduleType',
  prompts_per_day: 'notificationsPerDay',
  days: 'studyDuration',
  start_time: 'startTime',
  end_time: 'endTime',
  min_gap_minutes: 'minInterval',
  expires_after_minutes: 'expirationMinutes',
  goal_sessions: 'goalSessions',
  contact_email: 'researcherEmail',
  show_next_prompt_time: 'showNextNotification',
  allow_reschedule: 'allowRescheduleAndFullSchedule',
  start_tomorrow: 'delayNotifications',
  start_with_survey: 'startWithSurvey',
  one_survey_per_day: 'oneSurveyPerDay',
  participant_initiated: 'eventContingent',
};

const minutesOf = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

function checkSchedule(s) {
  const problems = [];
  const warnings = [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.endTime)) problems.push('start_time and end_time must be 24-hour "HH:mm", e.g. "09:00".');
  else {
    const window = minutesOf(s.endTime) - minutesOf(s.startTime);
    if (window <= 0) problems.push('end_time must be after start_time on the same day.');
    else if (!s.eventContingent && s.scheduleType === 'random' && s.minInterval > 0 && Math.floor(window / s.minInterval) < s.notificationsPerDay) {
      problems.push(`${s.notificationsPerDay} random prompts at least ${s.minInterval} minutes apart don't fit between ${s.startTime} and ${s.endTime}; widen the window, lower min_gap_minutes or prompts_per_day.`);
    }
  }
  if (s.expirationMinutes > s.minInterval && !s.eventContingent && s.notificationsPerDay > 1) {
    warnings.push(`Prompts stay open for ${s.expirationMinutes} minutes but can be ${s.minInterval} minutes apart, so one prompt can still be open when the next arrives.`);
  }
  // The apps treat exactly this combination as their 30-second demo mode.
  if (s.delayNotifications && s.notificationsPerDay === 1 && s.studyDuration === 1 && s.minInterval <= 30) {
    problems.push('start_tomorrow with 1 prompt, 1 day and min_gap_minutes ≤ 30 switches the apps into their demo mode (one prompt after 30 seconds). Change one of them.');
  }
  return { problems, warnings };
}

function esmOf(studyId) {
  const row = db.prepare('SELECT * FROM esm_studies WHERE study_id = ?').get(studyId);
  return row && { ...row, schedule: JSON.parse(row.schedule) };
}

const previewToken = (studyId) =>
  db.prepare("SELECT token FROM links WHERE study_id = ? AND kind = 'preview' ORDER BY created_at DESC LIMIT 1").get(studyId)?.token;

/** Create or change a study's ESM schedule. The first call also makes the live link app sessions run on. */
export function setSchedule(user, studyId, { app_title, survey_url, closed, ...fields }) {
  const study = findStudy(user, studyId, 'edit');
  const revision = currentRevision(study.id);
  const existing = esmOf(study.id);

  // Where sessions run: a hosted survey (survey_url) or the live experiment. Not given: stays as it was.
  let surveyUrl = existing?.survey_url ?? null;
  const surveyWarnings = [];
  if (survey_url !== undefined) {
    if (survey_url === null || survey_url === '') surveyUrl = null;
    else {
      let url;
      try { url = new URL(survey_url); } catch { throw new StudyError('survey_url must be the survey\'s full https link.'); }
      if (url.protocol !== 'https:') throw new StudyError('survey_url must be an https link (the apps refuse plain http).');
      if (!url.hostname.endsWith('qualtrics.com')) surveyWarnings.push(`${url.hostname} isn't a qualtrics.com address; fine for a custom Qualtrics domain, but check the link opens the survey.`);
      url.search = ''; url.hash = '';
      surveyUrl = url.toString();
    }
  }
  if (!surveyUrl && !revision) throw new StudyError('Write the momentary survey first (update_experiment), or give survey_url to use a survey hosted in Qualtrics; the ESM schedule needs one or the other.');

  const schedule = { ...DEFAULT_SCHEDULE, ...existing?.schedule };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || !FIELDS[name]) continue;
    if (value === null || value === '') delete schedule[FIELDS[name]];
    else schedule[FIELDS[name]] = value;
  }
  const { problems, warnings } = checkSchedule(schedule);
  if (problems.length) throw new StudyError(`Schedule not saved:\n- ${problems.join('\n- ')}`);
  let callbackKey = null;
  const title = app_title?.trim() || existing?.app_title;
  if (!title) throw new StudyError('Give app_title: the study name participants see in the app (the study title is researcher-facing).');

  db.exec('BEGIN IMMEDIATE');
  try {
    let linkToken = existing?.link_token ?? null;
    if (!linkToken && !surveyUrl) {
      linkToken = newToken();
      db.prepare(
        `INSERT INTO links (token, study_id, version_id, kind, recruitment, completion_url, label, created_by, created_at)
         VALUES (?, ?, ?, 'live', 'none', NULL, 'ESM app sessions', ?, ?)`
      ).run(linkToken, study.id, revision.id, user.id, now());
    }
    callbackKey = existing?.callback_key ?? (surveyUrl ? newToken() : null);
    db.prepare(
      `INSERT INTO esm_studies (study_id, app_title, schedule, link_token, survey_url, callback_key, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (study_id) DO UPDATE SET app_title = excluded.app_title, schedule = excluded.schedule, link_token = excluded.link_token,
         survey_url = excluded.survey_url, callback_key = excluded.callback_key, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(study.id, title, JSON.stringify(schedule), linkToken, surveyUrl, callbackKey, user.id, now());
    if (closed !== undefined) {
      const at = closed ? now() : null;
      db.prepare('UPDATE esm_studies SET closed_at = ? WHERE study_id = ?').run(at, study.id);
      if (linkToken) db.prepare('UPDATE links SET closed_at = ? WHERE token = ?').run(at, linkToken);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const enrolled = db.prepare('SELECT COUNT(*) AS n FROM esm_codes WHERE study_id = ? AND enrolled_at IS NOT NULL').get(study.id).n;
  return {
    study: study.id,
    app_title: title,
    schedule: describeSchedule(schedule),
    ...(warnings.length + surveyWarnings.length && { warnings: [...warnings, ...surveyWarnings] }),
    ...(surveyUrl && { survey_url: surveyUrl, qualtrics_setup: qualtricsSetup(callbackKey) }),
    note: (existing ? 'Schedule updated. ' : surveyUrl ? 'ESM is set up: each prompt opens the hosted survey. ' : 'ESM is set up: the live experiment is the momentary survey each prompt opens. ') +
      'Each participant keeps the schedule they enrolled with' + (enrolled ? ` (${enrolled} already enrolled keep their old one)` : '') + '. ' +
      'Give participants codes with create_esm_codes, or from an intake study with the esmCode block (get_authoring_guide).',
  };
}

const FIELD_NAMES = Object.fromEntries(Object.entries(FIELDS).map(([mcp, app]) => [app, mcp]));
const describeSchedule = (schedule) => Object.fromEntries(Object.entries(schedule).map(([k, v]) => [FIELD_NAMES[k] ?? k, v]));

export const completionUrl = (key) => `${config.runOrigin}/esm/done?key=${key}`;

function qualtricsSetup(key) {
  return {
    steps: [
      'Survey Flow, at the top: an Embedded Data element with the fields participant, sessionNumber, notificationTime and timezone (no values). The app adds them to the survey link and Qualtrics saves them with each response.',
      'Survey Flow, after the questions and before the last block: a Web Service element, method GET, URL below, with the four query parameters listed. This is what counts the session.',
      'Last block (after the Web Service): a text question with the JavaScript below, so the app closes the survey and shows the updated count. Put it after the Web Service so the count is already right.',
      'Survey Options: leave "Prevent multiple submissions" off, or a second prompt on the same phone is refused.',
      'Click Publish in Qualtrics. Flow, JavaScript and option changes only go live when published, and after any later edit it must be published again: an unpublished flow shows the default end message and never reports sessions.',
      'Try it with create_esm_codes test: true (start_with_survey: true makes the app offer a survey at once). esm_status lists recent completion calls and how each ended; none at all usually means the survey was not re-published.',
    ],
    web_service_url: completionUrl(key),
    web_service_query_parameters: {
      participant: '${e://Field/participant}',
      sessionNumber: '${e://Field/sessionNumber}',
      notificationTime: '${e://Field/notificationTime}',
      responseId: '${e://Field/ResponseID}',
    },
    last_page_javascript:
      "Qualtrics.SurveyEngine.addOnReady(function () {\n" +
      "  try {\n" +
      "    var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surveyComplete;\n" +
      "    if (h) h.postMessage('completed'); // iPhone, and Android once its shim is in\n" +
      "    else if (window.AndroidSurvey) window.AndroidSurvey.surveyComplete(); // Android\n" +
      "  } catch (e) {}\n" +
      "});",
    note: 'Data stays in Qualtrics: get_data has no rows for this study. esm_status shows enrolment, completed sessions and compliance from the Web Service calls.',
  };
}

/* ---------- Codes ---------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I; the same set MetaForge codes use
const newCode = () => `SO${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
export const showCode = (code) => `${code.slice(0, 2)}-${code.slice(2, 6)}-${code.slice(6)}`;
// Participants may type it with or without dashes and spaces, in any case.
const canonical = (typed) => String(typed ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function insertCode({ studyId, isTest, label = null, createdBy = null, sourceRun = null, externalRef = null }) {
  for (;;) {
    const code = newCode();
    const { changes } = db.prepare(
      `INSERT OR IGNORE INTO esm_codes (code, study_id, is_test, label, created_by, source_run_id, source_study_id, source_participant_id, external_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(code, studyId, isTest ? 1 : 0, label, createdBy, sourceRun?.id ?? null, sourceRun?.study_id ?? null, sourceRun?.participant_id ?? null, externalRef, now());
    if (changes) return code;
  }
}

export function createCodes(user, studyId, { count = 1, test = false, label }) {
  const study = findStudy(user, studyId, 'edit');
  if (!esmOf(study.id)) throw new StudyError('This study has no ESM schedule yet: set_esm_schedule first.');
  const codes = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < count; i++) codes.push(showCode(insertCode({ studyId: study.id, isTest: test, label: label?.trim() || null, createdBy: user.id })));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    codes,
    test,
    note: (test
      ? 'Test codes: their sessions run the preview and are saved as test data. '
      : 'Single-use codes, one per participant. ') +
      'Participants install "MetaForge Live" (iPhone) or "MetaForge EMA" (Android), enter the code, and get prompts on the schedule.',
  };
}

/**
 * The esmCode block in an intake study: one code per run and ESM study, so a reload shows the same code.
 * The run's own study can issue codes for an ESM study with the same owner, or one its owner can edit.
 */
export function codeForRun(run, targetStudyId) {
  const target = db.prepare('SELECT * FROM studies WHERE id = ?').get(String(targetStudyId));
  if (!target || !esmOf(target.id)) throw new StudyError(`"${targetStudyId}" is not an ESM study.`);
  if (target.id !== run.study_id) {
    const source = db.prepare('SELECT * FROM studies WHERE id = ?').get(run.study_id);
    const owner = source && db.prepare('SELECT * FROM users WHERE id = ?').get(source.owner_id);
    if (!owner || !['owner', 'editor'].includes(roleIn(owner, target))) throw new StudyError('This study can\'t issue codes for that ESM study.');
  }
  const existing = db.prepare('SELECT code FROM esm_codes WHERE source_run_id = ? AND study_id = ?').get(run.id, target.id);
  return showCode(existing?.code ?? insertCode({ studyId: target.id, isTest: run.is_test === 1, sourceRun: run }));
}

/* ---------- Codes for a Qualtrics intake survey ---------- */

const issuedByIntake = (studyId) => db.prepare('SELECT COUNT(*) AS n FROM esm_codes WHERE study_id = ? AND external_ref IS NOT NULL').get(studyId).n;
const MAX_INTAKE_CODES = 5000;

/** What a researcher adds to an intake survey built in Qualtrics so each respondent gets their own code. */
export function intakeSetup(user, studyId) {
  const study = findStudy(user, studyId, 'edit');
  const esm = esmOf(study.id);
  if (!esm) throw new StudyError('This study has no ESM schedule yet: set_esm_schedule first.');
  const key = esm.intake_key ?? newToken();
  if (!esm.intake_key) db.prepare('UPDATE esm_studies SET intake_key = ? WHERE study_id = ?').run(key, study.id);
  return {
    study: study.id,
    app_title: esm.app_title,
    steps: [
      'In the intake survey\'s Survey Flow, add an Embedded Data element (any name will do) with the field esmCode and no value, before the Web Service element.',
      'After the consent and baseline questions, add a Web Service element: method GET, the URL below, with the query parameters listed. Under "Map fields from response", map the response key code to the embedded data field esmCode.',
      'Add a block after it showing the code, e.g. "Your enrolment code is ${e://Field/esmCode}", with the install and enter instructions (below). Anyone who reloads or resumes the same response sees the same code.',
      'Publish the survey (and again after any later change). Test it in the live survey rather than the preview.',
    ],
    web_service_url: `${config.runOrigin}/esm/code?key=${key}`,
    web_service_query_parameters: { id: '${e://Field/ResponseID}' },
    optional_query_parameters: {
      ref: 'Something to find this person again, e.g. ${e://Field/PROLIFIC_PID}; shown in esm_status',
      test: '1 while testing the intake: test codes run the study as test data and stay out of esm_status',
    },
    suggested_instructions:
      'The next part of this study happens on your phone, over the coming days. 1. Install the free app: MetaForge Live from the App Store (iPhone) or MetaForge EMA from Google Play (Android). ' +
      '2. Open it, agree to the terms, and enter this code: ${e://Field/esmCode}. Please write the code down or take a screenshot before you continue. It can be used once, on one phone. ' +
      'Allow notifications when the app asks.',
    note: 'One code per Qualtrics response, so a repeat call returns the same code. Up to ' + MAX_INTAKE_CODES + ' codes can be issued this way. The URL contains a secret: anyone who has it can issue codes.',
  };
}

function issueForIntake(req, res) {
  const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const key = str(q.key, 100);
  const esm = key && db.prepare('SELECT * FROM esm_studies WHERE intake_key = ?').get(key);
  if (!esm) return fail(res, 403, 'Invalid key');
  if (isClosed(esm)) return fail(res, 410, 'This study is closed.');
  const id = str(q.id, 100);
  if (!id) return fail(res, 400, 'id is empty: send the response id (${e://Field/ResponseID}).');
  const ref = str(q.ref, 100);
  const existing = db.prepare('SELECT * FROM esm_codes WHERE external_ref = ? AND study_id = ?').get(id, esm.study_id);
  if (existing?.withdrawn_at) return fail(res, 410, 'This participant\'s data was deleted.');
  if (!existing && issuedByIntake(esm.study_id) >= MAX_INTAKE_CODES) return fail(res, 429, 'Too many codes issued for this study.');
  const code = existing?.code ?? insertCode({
    studyId: esm.study_id, isTest: ['1', 'true'].includes(str(q.test, 5)), label: ref ? `Qualtrics intake: ${ref}` : 'Qualtrics intake', externalRef: id,
  });
  res.json({ code: showCode(code) });
}

/* ---------- Runs started by the app ---------- */

export const SESSION_PARAMS = ['participant', 'sessionNumber', 'notificationTime', 'timezone'];

/**
 * For a run on an ESM study's app link (or its preview): the session parameters the app sends, and the
 * enrolled participant, if the participant parameter is one. Null for every other link.
 */
export function appRun(link, given) {
  const esm = db.prepare('SELECT link_token FROM esm_studies WHERE study_id = ?').get(link.study_id);
  if (!esm || (link.kind === 'live' && link.token !== esm.link_token)) return null;
  const params = Object.fromEntries(SESSION_PARAMS.filter((k) => typeof given[k] === 'string').map((k) => [k, given[k].slice(0, 100)]));
  const enrolment = params.participant && db.prepare(
    'SELECT * FROM esm_codes WHERE participant_id = ? AND study_id = ? AND withdrawn_at IS NULL'
  ).get(params.participant, link.study_id);
  const usable = enrolment && (link.kind === 'preview' || enrolment.is_test === 0);
  return { params, participantId: usable ? enrolment.participant_id : null };
}

const sessionsCompleted = (studyId, participantId) => (hosted(studyId)
  ? db.prepare('SELECT COUNT(*) AS n FROM esm_sessions WHERE study_id = ? AND participant_id = ?')
  : db.prepare('SELECT COUNT(*) AS n FROM runs WHERE study_id = ? AND participant_id = ? AND finished_at IS NOT NULL AND stopped IS NULL')
).get(studyId, participantId).n;

const hosted = (studyId) => !!db.prepare('SELECT survey_url FROM esm_studies WHERE study_id = ?').get(studyId)?.survey_url;
const isClosed = (esm) => !!esm.closed_at || !!(esm.link_token && db.prepare('SELECT closed_at FROM links WHERE token = ?').get(esm.link_token)?.closed_at);

/* ---------- Status ---------- */

export function esmStatus(user, studyId, { include_test = false } = {}) {
  const study = findStudy(user, studyId);
  const esm = esmOf(study.id);
  if (!esm) throw new StudyError('This study has no ESM schedule yet: set_esm_schedule first.');
  const closedAt = esm.closed_at ?? (esm.link_token && db.prepare('SELECT closed_at FROM links WHERE token = ?').get(esm.link_token)?.closed_at);
  const codes = db.prepare(`SELECT * FROM esm_codes WHERE study_id = ?${include_test ? '' : ' AND is_test = 0'} ORDER BY created_at`).all(study.id);
  const external = !!esm.survey_url;
  const lastSession = external
    ? db.prepare('SELECT MAX(completed_at) AS at FROM esm_sessions WHERE study_id = ? AND participant_id = ?')
    : db.prepare('SELECT MAX(finished_at) AS at FROM runs WHERE study_id = ? AND participant_id = ? AND finished_at IS NOT NULL AND stopped IS NULL');
  const started = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE study_id = ? AND participant_id = ?');

  const participants = codes.filter((c) => c.enrolled_at).map((c) => {
    const schedule = JSON.parse(c.schedule);
    const completed = sessionsCompleted(study.id, c.participant_id);
    const daysIn = Math.min(schedule.studyDuration, Math.max(0, (now() - c.enrolled_at) / DAY));
    // Prompts so far, for prompted schedules: whole days since enrolment (less a skipped first day).
    const promptedSoFar = schedule.eventContingent ? null
      : Math.max(0, Math.floor(daysIn) - (schedule.delayNotifications ? 1 : 0)) * (schedule.oneSurveyPerDay ? 1 : schedule.notificationsPerDay);
    const device = c.device ? JSON.parse(c.device) : {};
    return {
      participant_id: c.participant_id,
      code: showCode(c.code),
      ...(c.is_test && { test: true }),
      ...(c.label && { label: c.label }),
      ...(c.source_study_id && { from_study: c.source_study_id, from_participant: c.source_participant_id }),
      ...(c.external_ref && { from_qualtrics_response: c.external_ref }),
      platform: [device.platform, device.osVersion].filter(Boolean).join(' ') || null,
      enrolled: iso(c.enrolled_at),
      ends: iso(c.enrolled_at + schedule.studyDuration * DAY),
      ...(c.withdrawn_at && { withdrawn: iso(c.withdrawn_at) }),
      ...(!external && { sessions_started: started.get(study.id, c.participant_id).n }),
      sessions_completed: completed,
      ...(promptedSoFar != null && { prompts_so_far_approx: promptedSoFar, compliance: promptedSoFar ? Math.round((100 * completed) / promptedSoFar) / 100 : null }),
      ...(schedule.goalSessions && { goal_sessions: schedule.goalSessions }),
      last_session: iso(lastSession.get(study.id, c.participant_id).at),
    };
  });

  return {
    study: study.id,
    app_title: esm.app_title,
    ...(external && { survey_url: esm.survey_url, completion_url: completionUrl(esm.callback_key) }),
    sessions_link: closedAt ? `closed ${iso(closedAt)}: ${external ? 'enrolment and session reports are refused' : 'app sessions are refused'}` : 'open',
    schedule: describeSchedule(esm.schedule),
    codes: {
      issued: codes.length,
      unused: codes.filter((c) => !c.enrolled_at).length,
      enrolled: participants.length,
      withdrawn: codes.filter((c) => c.withdrawn_at).length,
    },
    participants,
    ...(external && {
      recent_completion_calls: db.prepare('SELECT at, method, outcome, received, user_agent FROM esm_done_calls WHERE study_id = ? ORDER BY at DESC LIMIT 8').all(study.id)
        .map((c) => ({ at: iso(c.at), method: c.method, outcome: c.outcome, received: JSON.parse(c.received), user_agent: c.user_agent })),
    }),
    note: 'compliance = completed sessions / prompts sent so far (approximate: counted in whole days since enrolment). ' +
      (external
        ? 'Responses are in Qualtrics, keyed by the participant, sessionNumber, notificationTime and timezone embedded data; a completed session is one the survey reported through its Web Service step.'
        : 'Session rows in get_data have param_participant, param_sessionNumber, param_notificationTime and param_timezone.'),
  };
}

/** After delete_participant_data: end that participant's enrolment, and unlink codes issued to them elsewhere. */
export function forgetParticipant(studyId, participantId) {
  db.prepare('UPDATE esm_codes SET withdrawn_at = COALESCE(withdrawn_at, ?), device = NULL, source_participant_id = NULL WHERE study_id = ? AND participant_id = ?')
    .run(now(), studyId, participantId);
  db.prepare('UPDATE esm_codes SET source_participant_id = NULL WHERE source_study_id = ? AND source_participant_id = ?').run(studyId, participantId);
  db.prepare('DELETE FROM esm_sessions WHERE study_id = ? AND participant_id = ?').run(studyId, participantId); // responses held in Qualtrics are the researcher's to delete
}

/* ---------- The apps' endpoints (run origin) ---------- */

export const esmApp = express.Router();
esmApp.use(['/emaValidateCode', '/emaEnroll', '/emaGetConfig', '/emaRecordSession'], express.json({ limit: '16kb' }));

const fail = (res, status, error) => res.status(status).json({ error });

// Guessing codes: at most 20 unknown codes per address per hour.
const misses = new Map();
setInterval(() => misses.clear(), 60 * 60 * 1000).unref();
const tooManyMisses = (req) => (misses.get(req.ip) ?? 0) >= 20;
const missed = (req) => misses.set(req.ip, (misses.get(req.ip) ?? 0) + 1);

function usableCode(req, res) {
  if (tooManyMisses(req)) return fail(res, 429, 'Too many attempts. Please try again in an hour.');
  const row = db.prepare('SELECT * FROM esm_codes WHERE code = ?').get(canonical(req.body?.code));
  if (!row) {
    missed(req);
    return fail(res, 404, 'Invalid code');
  }
  if (row.enrolled_at) return fail(res, 400, 'Code already used');
  const esm = esmOf(row.study_id);
  if (!esm || isClosed(esm)) return fail(res, 410, 'This study is no longer enrolling.');
  return { row, esm };
}

const surveyUrl = (esm, isTest) => esm.survey_url ?? `${config.runOrigin}/s/${isTest ? previewToken(esm.study_id) : esm.link_token}`;

esmApp.post('/emaValidateCode', (req, res) => {
  const found = usableCode(req, res);
  if (!found?.row) return;
  const { row, esm } = found;
  res.json({
    valid: true,
    experimentId: row.study_id,
    experimentTitle: esm.app_title,
    scheduleParams: esm.schedule,
    experimentUrl: surveyUrl(esm, row.is_test),
  });
});

esmApp.post('/emaEnroll', (req, res) => {
  const found = usableCode(req, res);
  if (!found?.row) return;
  const { row, esm } = found;
  const d = req.body?.deviceInfo && typeof req.body.deviceInfo === 'object' ? req.body.deviceInfo : {};
  const device = Object.fromEntries(['model', 'platform', 'osVersion', 'appVersion'].filter((k) => typeof d[k] === 'string').map((k) => [k, d[k].slice(0, 60)]));
  const participantId = `so_${randomBytes(8).toString('hex')}`;
  const { changes } = db.prepare(
    'UPDATE esm_codes SET participant_id = ?, schedule = ?, device = ?, enrolled_at = ? WHERE code = ? AND enrolled_at IS NULL'
  ).run(participantId, JSON.stringify(esm.schedule), JSON.stringify(device), now(), row.code);
  if (!changes) return fail(res, 400, 'Code already used');
  res.json({
    success: true,
    participantId,
    experimentId: row.study_id,
    experimentTitle: esm.app_title,
    experimentUrl: surveyUrl(esm, row.is_test),
    scheduleParams: esm.schedule,
  });
});

function enrolment(req, res) {
  const id = String(req.body?.participantId ?? req.query.participantId ?? '');
  const row = id && db.prepare('SELECT * FROM esm_codes WHERE participant_id = ? AND withdrawn_at IS NULL').get(id);
  if (!row) fail(res, 404, 'Participant not found');
  return row;
}

esmApp.post('/emaGetConfig', (req, res) => {
  const row = enrolment(req, res);
  if (!row) return;
  const esm = esmOf(row.study_id);
  res.json({
    experimentId: row.study_id,
    experimentTitle: esm.app_title,
    experimentUrl: surveyUrl(esm, row.is_test),
    scheduleParams: JSON.parse(row.schedule),
    enrolledAt: iso(row.enrolled_at),
    sessionsCompleted: sessionsCompleted(row.study_id, row.participant_id),
  });
});

// A hosted survey's Web Service step: one finished session. Repeats of the same response are ignored.
function done(req, res) {
  const q = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const key = str(q.key, 100);
  const esm = key && db.prepare('SELECT * FROM esm_studies WHERE callback_key = ?').get(key);
  if (!esm) return fail(res, 403, 'Invalid key');
  const received = JSON.stringify(Object.fromEntries(['participant', 'sessionNumber', 'notificationTime', 'responseId'].map((k) => [k, str(q[k], 200) || null])));
  const log = (outcome) => {
    db.prepare('INSERT INTO esm_done_calls (study_id, at, method, outcome, received, user_agent) VALUES (?, ?, ?, ?, ?, ?)')
      .run(esm.study_id, now(), req.method, outcome, received, String(req.get('user-agent') ?? '').slice(0, 120));
    db.prepare('DELETE FROM esm_done_calls WHERE study_id = ? AND at < (SELECT MIN(at) FROM (SELECT at FROM esm_done_calls WHERE study_id = ? ORDER BY at DESC LIMIT 30))').run(esm.study_id, esm.study_id);
  };
  if (isClosed(esm)) { log('refused: study closed'); return fail(res, 410, 'This study is closed.'); }
  const participant = str(q.participant, 100);
  const code = participant && db.prepare('SELECT * FROM esm_codes WHERE participant_id = ? AND study_id = ? AND withdrawn_at IS NULL').get(participant, esm.study_id);
  if (!code) { log(participant ? 'refused: participant not enrolled in this study' : 'refused: participant is empty (embedded data not set)'); return fail(res, 400, 'Unknown participant: is the participant embedded data field set in the survey?'); }
  const sessionNumber = Number.parseInt(str(q.sessionNumber, 10), 10);
  const responseId = str(q.responseId, 100) || null;
  const dedupe = responseId ?? `n${Number.isFinite(sessionNumber) ? sessionNumber : str(q.notificationTime, 40)}`;
  const { changes } = db.prepare(
    `INSERT OR IGNORE INTO esm_sessions (study_id, participant_id, dedupe, session_number, notification_time, response_id, is_test, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(esm.study_id, participant, dedupe, Number.isFinite(sessionNumber) ? sessionNumber : null, str(q.notificationTime, 40) || null, responseId, code.is_test, now());
  log(changes ? 'counted' : 'repeat of a session already counted');
  res.json({ success: true });
}
esmApp.get('/esm/code', issueForIntake);
esmApp.post('/esm/code', express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' }), issueForIntake);
esmApp.get('/esm/done', done);
esmApp.post('/esm/done', express.json({ limit: '4kb' }), express.urlencoded({ extended: false, limit: '4kb' }), done);

// Sessions are counted from the runs themselves when they finish; this only acknowledges the app.
esmApp.post('/emaRecordSession', (req, res) => {
  if (enrolment(req, res)) res.json({ success: true });
});

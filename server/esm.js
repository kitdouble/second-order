// ESM / EMA studies through the MetaForge phone apps ("MetaForge Live" on iPhone, "MetaForge EMA" on
// Android). The apps were built for metaforge.live; they send codes starting "SO-" here instead, and
// speak the same four endpoints (emaValidateCode, emaEnroll, emaGetConfig, emaRecordSession) on the
// run origin. Each app session opens the study's ESM link with ?participant=…&sessionNumber=…&
// notificationTime=…&timezone=…, runs the live experiment like any other run, and counts once it finishes.
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
export function setSchedule(user, studyId, { app_title, ...fields }) {
  const study = findStudy(user, studyId, 'edit');
  const revision = currentRevision(study.id);
  if (!revision) throw new StudyError('Write the momentary survey first (update_experiment); the ESM schedule runs the study\'s live experiment.');
  const existing = esmOf(study.id);

  const schedule = { ...DEFAULT_SCHEDULE, ...existing?.schedule };
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || !FIELDS[name]) continue;
    if (value === null || value === '') delete schedule[FIELDS[name]];
    else schedule[FIELDS[name]] = value;
  }
  const { problems, warnings } = checkSchedule(schedule);
  if (problems.length) throw new StudyError(`Schedule not saved:\n- ${problems.join('\n- ')}`);
  const title = app_title?.trim() || existing?.app_title;
  if (!title) throw new StudyError('Give app_title: the study name participants see in the app (the study title is researcher-facing).');

  db.exec('BEGIN IMMEDIATE');
  try {
    let linkToken = existing?.link_token;
    if (!linkToken) {
      linkToken = newToken();
      db.prepare(
        `INSERT INTO links (token, study_id, version_id, kind, recruitment, completion_url, label, created_by, created_at)
         VALUES (?, ?, ?, 'live', 'none', NULL, 'ESM app sessions', ?, ?)`
      ).run(linkToken, study.id, revision.id, user.id, now());
    }
    db.prepare(
      `INSERT INTO esm_studies (study_id, app_title, schedule, link_token, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (study_id) DO UPDATE SET app_title = excluded.app_title, schedule = excluded.schedule,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).run(study.id, title, JSON.stringify(schedule), linkToken, user.id, now());
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
    ...(warnings.length && { warnings }),
    note: (existing ? 'Schedule updated. ' : 'ESM is set up: the live experiment is the momentary survey each prompt opens. ') +
      'Each participant keeps the schedule they enrolled with' + (enrolled ? ` (${enrolled} already enrolled keep their old one)` : '') + '. ' +
      'Give participants codes with create_esm_codes, or from an intake study with the esmCode block (get_authoring_guide).',
  };
}

const FIELD_NAMES = Object.fromEntries(Object.entries(FIELDS).map(([mcp, app]) => [app, mcp]));
const describeSchedule = (schedule) => Object.fromEntries(Object.entries(schedule).map(([k, v]) => [FIELD_NAMES[k] ?? k, v]));

/* ---------- Codes ---------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I; the same set MetaForge codes use
const newCode = () => `SO${Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;
export const showCode = (code) => `${code.slice(0, 2)}-${code.slice(2, 6)}-${code.slice(6)}`;
// Participants may type it with or without dashes and spaces, in any case.
const canonical = (typed) => String(typed ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function insertCode({ studyId, isTest, label = null, createdBy = null, sourceRun = null }) {
  for (;;) {
    const code = newCode();
    const { changes } = db.prepare(
      `INSERT OR IGNORE INTO esm_codes (code, study_id, is_test, label, created_by, source_run_id, source_study_id, source_participant_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(code, studyId, isTest ? 1 : 0, label, createdBy, sourceRun?.id ?? null, sourceRun?.study_id ?? null, sourceRun?.participant_id ?? null, now());
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

const sessionsCompleted = (studyId, participantId) => db.prepare(
  'SELECT COUNT(*) AS n FROM runs WHERE study_id = ? AND participant_id = ? AND finished_at IS NOT NULL AND stopped IS NULL'
).get(studyId, participantId).n;

/* ---------- Status ---------- */

export function esmStatus(user, studyId, { include_test = false } = {}) {
  const study = findStudy(user, studyId);
  const esm = esmOf(study.id);
  if (!esm) throw new StudyError('This study has no ESM schedule yet: set_esm_schedule first.');
  const link = db.prepare('SELECT closed_at FROM links WHERE token = ?').get(esm.link_token);
  const codes = db.prepare(`SELECT * FROM esm_codes WHERE study_id = ?${include_test ? '' : ' AND is_test = 0'} ORDER BY created_at`).all(study.id);
  const lastSession = db.prepare(
    'SELECT MAX(finished_at) AS at FROM runs WHERE study_id = ? AND participant_id = ? AND finished_at IS NOT NULL AND stopped IS NULL'
  );
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
      platform: [device.platform, device.osVersion].filter(Boolean).join(' ') || null,
      enrolled: iso(c.enrolled_at),
      ends: iso(c.enrolled_at + schedule.studyDuration * DAY),
      ...(c.withdrawn_at && { withdrawn: iso(c.withdrawn_at) }),
      sessions_started: started.get(study.id, c.participant_id).n,
      sessions_completed: completed,
      ...(promptedSoFar != null && { prompts_so_far_approx: promptedSoFar, compliance: promptedSoFar ? Math.round((100 * completed) / promptedSoFar) / 100 : null }),
      ...(schedule.goalSessions && { goal_sessions: schedule.goalSessions }),
      last_session: iso(lastSession.get(study.id, c.participant_id).at),
    };
  });

  return {
    study: study.id,
    app_title: esm.app_title,
    sessions_link: link?.closed_at ? `closed ${iso(link.closed_at)}: app sessions are refused` : 'open',
    schedule: describeSchedule(esm.schedule),
    codes: {
      issued: codes.length,
      unused: codes.filter((c) => !c.enrolled_at).length,
      enrolled: participants.length,
      withdrawn: codes.filter((c) => c.withdrawn_at).length,
    },
    participants,
    note: 'compliance = completed sessions / prompts sent so far (approximate: counted in whole days since enrolment). ' +
      'Session rows in get_data have param_participant, param_sessionNumber, param_notificationTime and param_timezone.',
  };
}

/** After delete_participant_data: end that participant's enrolment, and unlink codes issued to them elsewhere. */
export function forgetParticipant(studyId, participantId) {
  db.prepare('UPDATE esm_codes SET withdrawn_at = COALESCE(withdrawn_at, ?), device = NULL, source_participant_id = NULL WHERE study_id = ? AND participant_id = ?')
    .run(now(), studyId, participantId);
  db.prepare('UPDATE esm_codes SET source_participant_id = NULL WHERE source_study_id = ? AND source_participant_id = ?').run(studyId, participantId);
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
  const link = esm && db.prepare('SELECT closed_at FROM links WHERE token = ?').get(esm.link_token);
  if (!esm || link.closed_at) return fail(res, 410, 'This study is no longer enrolling.');
  return { row, esm };
}

const surveyUrl = (esm, isTest) => `${config.runOrigin}/s/${isTest ? previewToken(esm.study_id) : esm.link_token}`;

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

// Sessions are counted from the runs themselves when they finish; this only acknowledges the app.
esmApp.post('/emaRecordSession', (req, res) => {
  if (enrolment(req, res)) res.json({ success: true });
});

// Data quality after a pilot (or any time): durations and pay, dropouts, fast responders, attention
// checks, response distributions, and the study's exclusion rules applied the same way everywhere.
import { db } from './db.js';
import { findStudy, iso, StudyError } from './studies.js';
import { summarise } from './simulate.js';
import { studyStatus } from './monitor.js';
import { PROLIFIC_GBP_PER_HOUR } from './lib/context.js';

export const DEFAULT_RULES = {
  require_completed: true,     // incomplete and stopped-early sessions are excluded
  min_minutes: null,           // faster than this is excluded
  fast_rt_ms: 200,             // a response quicker than this counts as "too fast"
  max_fast_share: null,        // excluded if more than this share (0–1) of responses are too fast
  attention: null,             // "all" = every attention check passed, or a number = at least that many passed
  exclude_participants: [],    // platform IDs excluded by hand
};

const RULE_KEYS = Object.keys(DEFAULT_RULES);

export function rulesFor(study) {
  return { ...DEFAULT_RULES, ...(study.exclusion_rules ? JSON.parse(study.exclusion_rules) : {}) };
}

export function setExclusionRules(user, studyId, rules) {
  const study = findStudy(user, studyId, 'edit');
  const unknown = Object.keys(rules).filter((k) => !RULE_KEYS.includes(k));
  if (unknown.length) throw new StudyError(`Unknown rule(s): ${unknown.join(', ')}. Rules are: ${RULE_KEYS.join(', ')}.`);
  const merged = { ...rulesFor(study), ...rules };
  db.prepare('UPDATE studies SET exclusion_rules = ? WHERE id = ?').run(JSON.stringify(merged), study.id);
  return { rules: merged, note: 'Applied by quality_report, and by get_data / create_download_link with exclusions "mark" or "drop".' };
}

const ATTENTION = /attention|catch trial/i;

/** Per-session quality measures and whether the rules exclude it. rows: the session's trial data. */
export function assess(run, rows, rules) {
  const rts = rows.map((r) => r.rt).filter((rt) => typeof rt === 'number');
  const fast = rts.filter((rt) => rt < rules.fast_rt_ms).length;
  const attention = rows.filter((r) => ATTENTION.test(r.trial_name ?? '') && 'correct' in r);
  const passed = attention.filter((r) => r.correct === true || r.correct === 1).length;
  const minutes = run.finished_at ? Math.round(((run.finished_at - run.started_at) / 60000) * 10) / 10 : null;
  const status = run.finished_at ? (run.stopped ? `stopped: ${run.stopped}` : 'completed') : 'incomplete';

  const reasons = [];
  if (rules.require_completed && status !== 'completed') reasons.push(status);
  if (rules.min_minutes != null && minutes != null && minutes < rules.min_minutes) reasons.push(`under ${rules.min_minutes} min`);
  if (rules.max_fast_share != null && rts.length && fast / rts.length > rules.max_fast_share) reasons.push(`${Math.round((fast / rts.length) * 100)}% responses under ${rules.fast_rt_ms} ms`);
  if (rules.attention === 'all' && passed < attention.length) reasons.push(`failed ${attention.length - passed} attention check(s)`);
  if (typeof rules.attention === 'number' && passed < rules.attention) reasons.push(`passed ${passed} of ${attention.length} attention checks`);
  if (run.participant_id && rules.exclude_participants?.includes(run.participant_id)) reasons.push('excluded by hand');

  return {
    status, minutes,
    fast_share: rts.length ? Math.round((fast / rts.length) * 100) / 100 : null,
    attention: attention.length ? `${passed}/${attention.length}` : null,
    excluded: reasons.length > 0,
    reasons,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

export function qualityReport(user, studyId, { version, include_test = false } = {}) {
  const study = findStudy(user, studyId);
  const rules = rulesFor(study);
  const runs = db.prepare(
    `SELECT r.*, v.number AS version, v.code FROM runs r JOIN study_versions v ON v.id = r.version_id
     WHERE r.study_id = ? ${include_test ? '' : 'AND r.is_test = 0'} ${version ? 'AND v.number = ?' : ''} ORDER BY r.started_at`
  ).all(study.id, ...(version ? [version] : []));
  if (!runs.length) throw new StudyError(include_test ? 'No sessions yet.' : 'No participant sessions yet. Use include_test: true to look at preview runs.');

  const rowsOf = db.prepare('SELECT data FROM trials WHERE run_id = ? ORDER BY trial_index');
  const sessions = runs.map((run) => {
    const rows = rowsOf.all(run.id).map((t) => JSON.parse(t.data));
    return { run, rows, quality: assess(run, rows, rules) };
  });
  const kept = sessions.filter((s) => !s.quality.excluded);
  const completed = sessions.filter((s) => s.quality.status === 'completed');

  // Length and pay, against what consent says.
  const stated = Number(runs.at(-1).code.match(/consent\(\s*\{[^}]*minutes\s*:\s*(\d+(?:\.\d+)?)/)?.[1]) || null;
  const medianMinutes = median(completed.map((s) => s.quality.minutes));
  const pay = stated && medianMinutes
    ? Math.round(((Math.ceil((stated / 60) * PROLIFIC_GBP_PER_HOUR * 100) / 100) / (medianMinutes / 60)) * 100) / 100
    : null;

  // Why people were excluded.
  const reasons = {};
  for (const s of sessions) for (const r of s.quality.reasons) reasons[r.replace(/\d+%/, 'many')] = (reasons[r.replace(/\d+%/, 'many')] ?? 0) + 1;

  const { design } = summarise(kept.map((s) => ({ rows: s.rows })));
  const status = studyStatus(user, studyId, { version });

  return {
    study: study.id, title: study.title, version: version ?? 'all', include_test,
    sessions: sessions.length, completed: completed.length, excluded: sessions.length - kept.length, kept: kept.length,
    exclusion_reasons: reasons,
    rules,
    length: {
      median_minutes: medianMinutes, stated_minutes: stated,
      ...(pay && { prolific_pay_per_hour_at_median: `£${pay.toFixed(2)}`, note: `Lab rate is £${PROLIFIC_GBP_PER_HOUR}/hour.` }),
    },
    dropouts: status.dropouts,
    participants: sessions.slice(-60).reverse().map((s) => ({
      participant: s.run.participant_id ? `${s.run.participant_id.slice(0, 4)}…` : null, run_id: s.run.id, version: s.run.version,
      started: iso(s.run.started_at), ...s.quality,
    })),
    responses_kept_participants: design,
    note: 'participants lists the 60 most recent sessions. Exclusions use the study\'s rules (set_exclusion_rules); they never delete data.',
  };
}

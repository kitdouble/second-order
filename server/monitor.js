// study_status (how a study is going) and check_launch (is the live experiment ready for participants).
import { db, now } from './db.js';
import { config } from './config.js';
import { describeStudy, findStudy, iso, linkUrl, StudyError } from './studies.js';
import { simulate } from './simulate.js';

const ACTIVE_WINDOW = 30 * 60 * 1000;
const minutes = (ms) => Math.round(ms / 6000) / 10;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (pos - lo);
}

export function browserOf(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return `${browser} on ${os}`;
}

const mask = (id) => (id ? `${id.slice(0, 4)}…` : null);

function statusOf(run, at) {
  if (run.finished_at) return run.stopped ? `stopped (${run.stopped})` : 'completed';
  return (run.last_seen_at ?? run.started_at) > at - ACTIVE_WINDOW ? 'in progress' : 'abandoned';
}

/** Durations (minutes) of completed runs, as {median, p25, p75, n}. */
function durations(runs) {
  const done = runs.filter((r) => r.finished_at && !r.stopped).map((r) => r.finished_at - r.started_at).sort((a, b) => a - b);
  return { n: done.length, median: done.length ? minutes(quantile(done, 0.5)) : null, p25: done.length ? minutes(quantile(done, 0.25)) : null, p75: done.length ? minutes(quantile(done, 0.75)) : null };
}

function summariseRuns(runs, at) {
  const counts = { started: runs.length, completed: 0, in_progress: 0, abandoned: 0, stopped: {} };
  for (const run of runs) {
    const status = statusOf(run, at);
    if (status === 'completed') counts.completed++;
    else if (status === 'in progress') counts.in_progress++;
    else if (status === 'abandoned') counts.abandoned++;
    else counts.stopped[run.stopped] = (counts.stopped[run.stopped] ?? 0) + 1;
  }
  return {
    ...counts,
    completion_rate: runs.length ? Math.round((counts.completed / runs.length) * 100) / 100 : null,
    resumed: runs.filter((r) => r.attempts > 1).length,
    minutes: durations(runs),
  };
}

// Where people who didn't finish left off.
function dropouts(runs, at) {
  const left = new Map();
  for (const run of runs) {
    if (statusOf(run, at) !== 'abandoned') continue;
    const where = run.last_trial_index == null ? 'before the first trial' : `${run.last_trial_name ?? 'unnamed trial'} (after trial ${run.last_trial_index})`;
    left.set(where, (left.get(where) ?? 0) + 1);
  }
  return [...left].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([where, n]) => ({ where, participants: n }));
}

function errors(runIds) {
  if (!runIds.length) return [];
  const rows = db.prepare(
    `SELECT e.message, e.trial_name, e.run_id, r.user_agent FROM run_events e JOIN runs r ON r.id = e.run_id
     WHERE e.kind = 'error' AND e.run_id IN (${runIds.map(() => '?').join(',')})`
  ).all(...runIds);
  const groups = new Map();
  for (const row of rows) {
    const g = groups.get(row.message) ?? { message: row.message, count: 0, runs: new Set(), trials: new Set(), browsers: new Set() };
    g.count++;
    g.runs.add(row.run_id);
    if (row.trial_name) g.trials.add(row.trial_name);
    g.browsers.add(browserOf(row.user_agent));
    groups.set(row.message, g);
  }
  return [...groups.values()].sort((a, b) => b.runs.size - a.runs.size).slice(0, 10)
    .map((g) => ({ message: g.message, participants: g.runs.size, times: g.count, trials: [...g.trials], browsers: [...g.browsers] }));
}

export function studyStatus(user, studyId) {
  const study = findStudy(user, studyId);
  const at = now();
  const all = db.prepare(
    `SELECT r.*, v.number AS revision FROM runs r JOIN study_versions v ON v.id = r.version_id WHERE r.study_id = ?
     ORDER BY r.started_at DESC`
  ).all(study.id);
  const real = all.filter((r) => !r.is_test);
  const test = all.filter((r) => r.is_test);
  const links = db.prepare("SELECT * FROM links WHERE study_id = ? AND kind = 'live' ORDER BY created_at").all(study.id);

  return {
    study: study.id,
    title: study.title,
    as_of: iso(at),
    participants: summariseRuns(real, at),
    links: links.map((link) => ({
      label: link.label, recruitment: link.recruitment, status: link.closed_at ? 'closed' : 'open', url: linkUrl(link),
      ...summariseRuns(real.filter((r) => r.link_token === link.token), at),
    })),
    dropouts: dropouts(real, at),
    errors: errors(real.map((r) => r.id)),
    browsers: Object.entries(real.reduce((acc, r) => ({ ...acc, [browserOf(r.user_agent)]: (acc[browserOf(r.user_agent)] ?? 0) + 1 }), {}))
      .sort((a, b) => b[1] - a[1]).map(([browser, n]) => ({ browser, participants: n })),
    recent: real.slice(0, 10).map((r) => ({
      participant: mask(r.participant_id), revision: r.revision, status: statusOf(r, at), started: iso(r.started_at),
      minutes: r.finished_at ? minutes(r.finished_at - r.started_at) : null,
      last_trial: r.last_trial_name ?? (r.last_trial_index != null ? `trial ${r.last_trial_index}` : null),
      attempts: r.attempts,
    })),
    previews: { ...summariseRuns(test, at), errors: errors(test.map((r) => r.id)) },
  };
}

/* ---------- Launch check ---------- */

const LINK_PATTERNS = {
  prolific: /^https:\/\/app\.prolific\.com\/submissions\/complete\?cc=[A-Za-z0-9]+$/,
  sona: /^https:\/\/[a-z0-9-]+\.sona-systems\.com\/.*survey_code=XXXX/,
};

export async function checkLaunch(user, studyId, { recruitment = 'prolific', completion_url, required_columns = [] } = {}) {
  const study = describeStudy(user, studyId);
  if (!study.revision) throw new StudyError('This study has no experiment yet.');
  const v = db.prepare('SELECT * FROM study_versions WHERE study_id = ? AND number = ?').get(study.id, study.revision);
  const checks = [];
  const add = (status, check, detail) => checks.push({ status, check, detail });

  // Simulation
  const sim = await simulate(user, studyId, { participants: 5, recruitment });
  const failed = sim.participants.filter((p) => !p.ok);
  const stopped = sim.participants.filter((p) => p.ok && p.stopped);
  if (failed.length) add('fail', 'Simulation', `${failed.length} of 5 simulated participants failed: ${failed[0].error.split('\n')[0]}`);
  else if (stopped.length === 5) add('fail', 'Simulation', `Every simulated participant was stopped early (${stopped[0].stopped}).`);
  else add('pass', 'Simulation', `5 simulated participants ran${stopped.length ? `, ${stopped.length} stopped early (${stopped[0].stopped})` : ''}.`);
  if (sim.stand_ins) add('warn', 'Simulation coverage', sim.stand_ins);

  const has = (column) => sim.columns.includes(column);
  const counts = (column) => sim.value_counts[column]?.counts ?? sim.technical_value_counts[column]?.counts ?? {};

  // Ethics blocks
  if (recruitment === 'prolific' || recruitment === 'sona') {
    if (has('consent_form')) add('pass', 'Consent form', `Shown: ${Object.keys(counts('consent_form')).join(', ')}.`);
    else add('warn', 'Consent form', 'No consent() block found. Only fine if the study uses its own ethics-approved consent trial.');
  } else {
    add('warn', 'Consent form', 'There is no approved in-lab consent form in Second Order: check the study includes your approved wording.');
  }
  if (recruitment === 'sona') {
    if (has('debrief_form')) add('pass', 'Debrief', 'SONA debrief is shown.');
    else add('warn', 'Debrief', 'No debrief() block: SONA studies under HREC 2022/796 should end with it.');
  }

  // Length and pay
  const stated = Number(v.code.match(/consent\(\s*\{[^}]*minutes\s*:\s*(\d+(?:\.\d+)?)/)?.[1]);
  // Runs of this code (rebuilds for changed stimuli keep the same code).
  const sameCode = `SELECT r.* FROM runs r JOIN study_versions x ON x.id = r.version_id WHERE x.study_id = ? AND x.code = ?`;
  const timed = db.prepare(`${sameCode} AND r.finished_at IS NOT NULL AND r.stopped IS NULL`).all(study.id, v.code);
  const measured = durations(timed);
  if (!measured.n) {
    add('warn', 'Length', `Nobody has completed the current experiment yet${stated ? ` (consent says ${stated} minutes)` : ''}. Complete the preview once to time it.`);
  } else if (stated && measured.median > stated * 1.25) {
    add('warn', 'Length', `Median ${measured.median} min over ${measured.n} completed run(s), but consent says ${stated} min. Update consent({ minutes }) so the stated length and pay are fair.`);
  } else {
    add('pass', 'Length', `Median ${measured.median} min over ${measured.n} completed run(s)${stated ? `; consent says ${stated} min` : ''}.`);
  }

  // Previewed by a person
  const previewed = db.prepare(`SELECT COUNT(*) AS n FROM (${sameCode} AND r.is_test = 1 AND r.finished_at IS NOT NULL)`).get(study.id, v.code).n;
  if (previewed) add('pass', 'Previewed', `${previewed} completed preview run(s) since the last change to the code.`);
  else add('warn', 'Previewed', `Nobody has completed the preview since the last change to the code: ${study.preview_url}`);

  // Devices
  if (has('device_type')) add('pass', 'Device check', 'deviceCheck() is included.');
  else add('warn', 'Device check', 'No deviceCheck(): participants on phones or tablets can take part. Add it unless every device is fine.');

  // Stimuli
  const stimuli = JSON.parse(v.stimuli);
  const names = Object.keys(stimuli);
  if (names.length) {
    const bytes = db.prepare(`SELECT COALESCE(SUM(size), 0) AS b FROM (SELECT DISTINCT sha256, size FROM stimuli WHERE sha256 IN (${names.map(() => '?').join(',')}))`)
      .get(...Object.values(stimuli)).b;
    const mb = Math.round(bytes / 1024 / 102.4) / 10;
    if (!counts('trial_type').preload) add('warn', 'Preloading', `${names.length} stimuli but no preload(jsPsych) block: files load mid-trial, which can delay stimuli.`);
    else add(mb > 100 ? 'warn' : 'pass', 'Stimuli', `${names.length} files, ${mb} MB${mb > 100 ? ': slow on weak connections; consider compressing' : ''}.`);
  }

  // Assignment
  const usesAssign = /assignCondition\s*\(/.test(v.code);
  const randomCondition = /addProperties\s*\(\s*\{[^}]*\b(condition|group)\b/.test(v.code) && /randomization\.|Math\.random/.test(v.code);
  if (usesAssign) add('pass', 'Condition assignment', 'Balanced, server-side (assignCondition).');
  else if (randomCondition) add('warn', 'Condition assignment', 'Conditions look randomly chosen in the browser, which does not keep groups balanced. Use await assignCondition([...]).');

  // Attention checks
  const named = (sim.value_counts.trial_name?.counts) ?? {};
  if (Object.keys(named).some((n) => /attention|catch|check/i.test(n)) || /attention/i.test(v.code)) add('pass', 'Attention checks', 'Found.');
  else add('warn', 'Attention checks', 'None found (no trial named like "attention check"). Fine if not needed for this design.');

  // Columns the analysis needs
  for (const column of required_columns) {
    if (has(column)) add('pass', `Column ${column}`, 'Recorded.');
    else add('fail', `Column ${column}`, 'Not in the simulated data.');
  }

  // Completion URL
  if (LINK_PATTERNS[recruitment]) {
    if (!completion_url) add('warn', 'Completion URL', `You'll need the ${recruitment === 'prolific' ? 'Prolific completion URL' : 'SONA completion URL (with survey_code=XXXX)'} to create the link.`);
    else if (LINK_PATTERNS[recruitment].test(completion_url)) add('pass', 'Completion URL', 'Looks right.');
    else add('fail', 'Completion URL', recruitment === 'prolific' ? 'Should look like https://app.prolific.com/submissions/complete?cc=ABC123' : 'Should be the SONA completion URL with survey_code=XXXX left as is.');
  }

  // Open links run changes immediately
  const open = study.participant_links.filter((l) => l.status === 'open');
  if (open.length) add('warn', 'Open links', `${open.length} participant link(s) are open: every update to the experiment reaches them straight away.`);

  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return {
    study: study.id, title: study.title, revision: study.revision, recruitment,
    ready: fails === 0,
    summary: fails ? `${fails} problem(s) to fix before launch, ${warns} warning(s).` : warns ? `No blockers; ${warns} warning(s) to review.` : 'Ready to launch.',
    checks,
    note: `Run on ${config.origin} at ${iso(now())}. Creating a participant link never recruits anyone: the researcher launches on the platform.`,
  };
}

// Service layer. Every action goes through here, whether it comes from the
// web UI or from an agent over MCP, so permissions and audit are identical.
import {
  validateSpec,
  specToYaml,
  hashSpec,
  shortHash,
  diffSpecs,
  runQa as coreQa,
  runSimulation as coreSim,
  listConditions,
  generateRScript,
  generatePrereg,
  trialsCsv,
  participantsCsv,
  runChecks,
  blockCatalog,
  getBlock,
  stepId,
  estimateMinutes,
  scoreParticipant,
} from "@so/core";
import { prolificClient } from "@so/core/prolific";
import { q, one, tx, j } from "./db.js";
import { audit } from "./audit.js";
import { newToken, sha256 } from "./tokens.js";

export class ServiceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (m, status) => {
  throw new ServiceError(m, status);
};

export const PROLIFIC_FEE = 1 / 3; // academic service fee on top of rewards
export const TRUSTED_CAP = 200;
const isLabHead = (a) => a.user.tier === "lab_head";

// ---------------------------------------------------------------- access

async function loadStudy(actor, slug) {
  const s = await one(
    `SELECT s.*, u.name AS owner_name, u.tier AS owner_tier FROM studies s JOIN users u ON u.id = s.owner_id WHERE s.slug = $1`,
    [slug],
  );
  if (!s || !(isLabHead(actor) || s.owner_id === actor.user.id)) fail(`No study "${slug}" that you can see.`, 404);
  return s;
}

const canEdit = (actor, s) => isLabHead(actor) || s.owner_id === actor.user.id;

async function versionOf(study, hash) {
  const h = hash ?? study.current_hash;
  if (!h) fail("This study has no spec yet.");
  const v = await one("SELECT * FROM spec_versions WHERE study_id = $1 AND hash LIKE $2 || '%' ORDER BY created_at DESC LIMIT 1", [
    study.id,
    h,
  ]);
  if (!v) fail(`No version ${h} in ${study.slug}.`, 404);
  return v;
}

export function estimatedSpend(spec, n) {
  const reward = spec.recruitment.reward_per_participant;
  if (reward === undefined) return null;
  return Math.round(n * reward * (1 + PROLIFIC_FEE) * 100) / 100;
}

function pilotN(spec) {
  return (spec.pilot?.n_per_condition ?? 6) * listConditions(spec).length;
}

// ---------------------------------------------------------------- listing

export async function listStudies(actor) {
  const r = await q(
    `SELECT s.slug, s.title, s.status, s.status_note, s.current_hash, s.updated_at, u.name AS owner_name,
            (SELECT count(*) FROM comments c WHERE c.study_id = s.id AND c.status = 'open' AND c.severity IS NOT NULL) AS open_findings,
            (SELECT count(*) FROM reviews r WHERE r.study_id = s.id AND r.status = 'open') AS open_reviews
     FROM studies s JOIN users u ON u.id = s.owner_id
     WHERE $1 OR s.owner_id = $2 ORDER BY s.updated_at DESC`,
    [isLabHead(actor), actor.user.id],
  );
  return r.rows;
}

export async function reviewQueue(actor) {
  const r = await q(
    `SELECT r.id, r.gate, r.summary, r.created_at, s.slug, s.title, u.name AS requested_by
     FROM reviews r JOIN studies s ON s.id = r.study_id LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.status = 'open' AND ($1 OR s.owner_id = $2) ORDER BY r.created_at`,
    [isLabHead(actor), actor.user.id],
  );
  return r.rows;
}

export async function search(actor, query) {
  const like = `%${query}%`;
  const studies = await q(
    `SELECT DISTINCT s.slug, s.title, s.status FROM studies s LEFT JOIN spec_versions v ON v.study_id = s.id
     WHERE ($1 OR s.owner_id = $2) AND (s.title ILIKE $3 OR s.slug ILIKE $3 OR v.yaml ILIKE $3) LIMIT 20`,
    [isLabHead(actor), actor.user.id, like],
  );
  const notes = await q(
    `SELECT s.slug, i.kind, i.title, left(i.content, 200) AS excerpt, i.created_at FROM saved_items i JOIN studies s ON s.id = i.study_id
     WHERE ($1 OR s.owner_id = $2) AND (i.title ILIKE $3 OR i.content ILIKE $3) ORDER BY i.created_at DESC LIMIT 10`,
    [isLabHead(actor), actor.user.id, like],
  );
  const comments = await q(
    `SELECT s.slug, c.body, c.severity, c.status, c.created_at FROM comments c JOIN studies s ON s.id = c.study_id
     WHERE ($1 OR s.owner_id = $2) AND c.body ILIKE $3 ORDER BY c.created_at DESC LIMIT 10`,
    [isLabHead(actor), actor.user.id, like],
  );
  return { studies: studies.rows, saved_items: notes.rows, comments: comments.rows };
}

// ---------------------------------------------------------------- specs

/**
 * Creates or updates a study from YAML. Every save is a new immutable
 * version identified by its content hash. Saving voids any pending approval.
 */
export async function saveSpec(actor, { yaml, message = null, baseHash = null, expectSlug = null }) {
  const v = validateSpec(yaml);
  if (!v.spec) return { ok: false, saved: false, errors: v.errors, warnings: [] };
  const spec = v.spec;
  if (expectSlug && spec.study.slug !== expectSlug) {
    return { ok: false, saved: false, errors: [{ path: "study.slug", message: `This spec is for "${spec.study.slug}", not "${expectSlug}". Slugs can't change; fork instead.` }] };
  }
  const hash = await hashSpec(spec);
  const validation = { ok: v.ok, errors: v.errors, warnings: v.warnings };

  const result = await tx(async (c) => {
    let study = (await c.query("SELECT * FROM studies WHERE slug = $1 FOR UPDATE", [spec.study.slug])).rows[0];
    if (study) {
      if (!canEdit(actor, study)) fail(`"${spec.study.slug}" belongs to someone else. Fork it under a new slug instead.`, 403);
      if (baseHash && study.current_hash && !study.current_hash.startsWith(baseHash)) {
        fail(`The spec changed since you read it (now ${shortHash(study.current_hash)}). Get the latest version and re-apply your edit.`, 409);
      }
    } else {
      study = (
        await c.query("INSERT INTO studies (slug, title, owner_id) VALUES ($1,$2,$3) RETURNING *", [spec.study.slug, spec.study.title, actor.user.id])
      ).rows[0];
    }
    const parent = study.current_hash;
    await c.query(
      `INSERT INTO spec_versions (hash, study_id, yaml, spec, parent_hash, message, created_by, created_via, validation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (hash) DO NOTHING`,
      [hash, study.id, yaml, j(spec), parent === hash ? null : parent, message, actor.user.id, actor.client, j(validation)],
    );
    const unchanged = parent === hash;
    let status = study.status;
    if (!unchanged && ["in_review", "approved"].includes(study.status)) {
      status = "draft";
      await c.query("UPDATE reviews SET status = 'superseded' WHERE study_id = $1 AND status = 'open'", [study.id]);
    }
    await c.query("UPDATE studies SET current_hash = $2, title = $3, status = $4, updated_at = now() WHERE id = $1", [
      study.id,
      hash,
      spec.study.title,
      status,
    ]);
    return { study, parent, unchanged, status };
  });

  let diff = null;
  if (result.parent && !result.unchanged) {
    const p = await one("SELECT spec FROM spec_versions WHERE hash = $1", [result.parent]);
    diff = diffSpecs(p.spec, spec);
  }
  // Design critic: on the first version and whenever the design changes.
  if (!result.unchanged && (!result.parent || (diff && diff.major.length))) {
    await queueAiTask(result.study.id, hash, "design_critic");
  }
  if (!result.unchanged) await audit(actor, "spec_saved", { studyId: result.study.id, hash, detail: { ok: v.ok, message, diff: diff?.summary } });

  return {
    ok: v.ok,
    saved: true,
    study: spec.study.slug,
    hash,
    short: shortHash(hash),
    unchanged: result.unchanged,
    status: result.status,
    errors: v.errors,
    warnings: v.warnings,
    diff: diff ? { summary: diff.summary, major: diff.major.map((d) => d.sentence), minor: diff.minor.map((d) => d.sentence) } : null,
    next_step: v.ok
      ? 'Valid. Next: run check with kind "qa", then "simulate", then open a preview link.'
      : "Saved as a draft with errors. Fix the errors listed (each has a path) and save again.",
  };
}

export async function forkStudy(actor, fromSlug, newSlug, title) {
  const from = await loadStudy(actor, fromSlug);
  const v = await versionOf(from, null);
  const spec = structuredClone(v.spec);
  spec.study.slug = newSlug;
  spec.study.title = title ?? `${spec.study.title} (fork)`;
  spec.study.forked_from = `${fromSlug}@${shortHash(v.hash)}`;
  const res = await saveSpec(actor, { yaml: specToYaml(spec), message: `Forked from ${fromSlug}` });
  if (res.saved) res.diff_from_parent_study = diffSpecs(v.spec, spec).major.map((d) => d.sentence);
  return res;
}

export async function getSpec(actor, slug, hash = null) {
  const s = await loadStudy(actor, slug);
  const v = await versionOf(s, hash);
  return {
    study: slug,
    hash: v.hash,
    short: shortHash(v.hash),
    parent: v.parent_hash,
    is_current: v.hash === s.current_hash,
    yaml: v.yaml,
    validation: v.validation,
    message: v.message,
    created_at: v.created_at,
  };
}

export async function listVersions(actor, slug) {
  const s = await loadStudy(actor, slug);
  const r = await q(
    `SELECT v.hash, v.parent_hash, v.message, v.created_via, v.created_at, (v.validation->>'ok')::boolean AS valid, u.name AS author
     FROM spec_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.study_id = $1 ORDER BY v.created_at DESC LIMIT 50`,
    [s.id],
  );
  return r.rows.map((x) => ({ ...x, short: shortHash(x.hash) }));
}

export async function diffVersions(actor, slug, fromHash = null, toHash = null) {
  const s = await loadStudy(actor, slug);
  const to = await versionOf(s, toHash);
  const fromH = fromHash ?? to.parent_hash;
  if (!fromH) return { summary: "First version; nothing to compare.", major: [], minor: [] };
  const from = await versionOf(s, fromH);
  const d = diffSpecs(from.spec, to.spec);
  return { from: shortHash(from.hash), to: shortHash(to.hash), summary: d.summary, major: d.major.map((x) => x.sentence), minor: d.minor.map((x) => x.sentence) };
}

// ---------------------------------------------------------------- checks

async function storeReport(study, hash, kind, body, actor) {
  await q("INSERT INTO reports (study_id, hash, kind, body, created_by) VALUES ($1,$2,$3,$4,$5)", [study.id, hash, kind, j(body), actor?.user?.id ?? null]);
}

export async function latestReport(studyId, hash, kind) {
  return one("SELECT body, created_at FROM reports WHERE study_id = $1 AND hash = $2 AND kind = $3 ORDER BY created_at DESC LIMIT 1", [
    studyId,
    hash,
    kind,
  ]);
}

export async function runQa(actor, slug, hash = null) {
  const s = await loadStudy(actor, slug);
  const v = await versionOf(s, hash);
  if (!v.validation.ok) fail("Fix the validation errors before running QA.");
  const report = coreQa(v.spec, { seed: v.hash });
  await storeReport(s, v.hash, "qa", report, actor);
  await audit(actor, "qa_run", { studyId: s.id, hash: v.hash, detail: { ok: report.ok, findings: report.findings.length } });
  return { hash: shortHash(v.hash), ...report };
}

export async function runSimulation(actor, slug, { hash = null, reps = null, n_per_group = null } = {}) {
  const s = await loadStudy(actor, slug);
  const v = await versionOf(s, hash);
  if (!v.validation.ok) fail("Fix the validation errors before simulating.");
  // Firebase Hosting cuts requests off at 60 s; stay well inside that.
  const report = coreSim(v.spec, { reps: reps ?? undefined, nPerGroup: n_per_group ?? undefined, seed: v.hash, budgetMs: 40000 });
  await storeReport(s, v.hash, "simulation", report, actor);
  await audit(actor, "simulation_run", { studyId: s.id, hash: v.hash, detail: { reps: report.reps_done } });
  return { hash: shortHash(v.hash), ...report };
}

export async function makePreview(actor, slug, baseUrl, hash = null) {
  const s = await loadStudy(actor, slug);
  const v = await versionOf(s, hash);
  if (!v.validation.ok) fail("Fix the validation errors before previewing.");
  const token = newToken(16);
  await q("INSERT INTO preview_tokens (token_hash, hash, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '3 days')", [
    sha256(token),
    v.hash,
    actor.user.id,
  ]);
  const base = `${baseUrl}/s/${v.hash.slice(0, 16)}/?preview=${token}`;
  return {
    hash: shortHash(v.hash),
    expires_in_days: 3,
    links: listConditions(v.spec).map((c) => ({
      condition: c.key,
      full: `${base}&cond=${encodeURIComponent(c.key)}`,
      quick: `${base}&cond=${encodeURIComponent(c.key)}&quick=1`,
    })),
    note: "Preview data is stored separately and never analysed. 'quick' cuts task steps to 6 trials.",
  };
}

// ---------------------------------------------------------------- review

async function openBlockers(studyId) {
  return (await q("SELECT id, body, path FROM comments WHERE study_id = $1 AND severity = 'blocker' AND status = 'open'", [studyId])).rows;
}

export async function requestReview(actor, slug, summary = null) {
  const s = await loadStudy(actor, slug);
  if (!canEdit(actor, s)) fail("Only the owner or the lab head can request review.", 403);
  const v = await versionOf(s, null);
  if (!v.validation.ok) fail("The current version has validation errors.");
  const qa = await latestReport(s.id, v.hash, "qa");
  if (!qa) fail('Run QA on the current version first (check, kind "qa").');
  if (!qa.body.ok) fail("QA found blockers on the current version. Fix them and rerun QA.");

  let gate;
  if (["draft", "in_review", "approved"].includes(s.status)) gate = "pilot";
  else if (s.status === "pilot_review") gate = v.hash === s.approved_hash ? "go_live" : "pilot";
  else fail(`Can't request review while the study is ${s.status}.`);

  await tx(async (c) => {
    await c.query("UPDATE reviews SET status = 'superseded' WHERE study_id = $1 AND status = 'open'", [s.id]);
    await c.query("INSERT INTO reviews (study_id, hash, gate, summary, requested_by) VALUES ($1,$2,$3,$4,$5)", [s.id, v.hash, gate, summary, actor.user.id]);
    if (gate === "pilot") await c.query("UPDATE studies SET status = 'in_review', updated_at = now() WHERE id = $1", [s.id]);
  });
  await queueAiTask(s.id, v.hash, "verification");
  await audit(actor, "review_requested", { studyId: s.id, hash: v.hash, detail: { gate } });
  return {
    gate,
    hash: shortHash(v.hash),
    message: `Review requested (${gate === "pilot" ? "approve for pilot" : "approve go-live"}). An AI verification task has been queued.`,
  };
}

/** Who may approve this gate for this study? */
export async function approvalRight(actor, s, spec, gate) {
  if (isLabHead(actor)) return { ok: true };
  if (spec.sequence.some((it) => getBlock(spec.blocks[it.use])?.custom)) {
    return { ok: false, reason: "This study runs custom code, so the lab head approves it whatever the tier." };
  }
  if (s.owner_id !== actor.user.id) return { ok: false, reason: "Only the lab head can approve other people's studies." };
  if (actor.user.tier !== "trusted") return { ok: false, reason: "Supervised studies need the lab head's approval." };
  const spend = estimatedSpend(spec, gate === "pilot" ? pilotN(spec) : spec.recruitment.max_n);
  if (spend === null) return { ok: false, reason: "Set recruitment.reward_per_participant so spend can be checked." };
  if (spend > TRUSTED_CAP) return { ok: false, reason: `Estimated spend ${spend} is over the ${TRUSTED_CAP} limit for self-approval; the lab head needs to approve.` };
  return { ok: true };
}

export async function decideReview(actor, slug, { decision, note = null }) {
  if (actor.client !== "web") fail("Approvals can only be made by a person in the web app.", 403);
  const s = await loadStudy(actor, slug);
  const r = await one("SELECT * FROM reviews WHERE study_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 1", [s.id]);
  if (!r) fail("There is no open review.");
  const v = await versionOf(s, r.hash);
  if (decision === "approve") {
    const right = await approvalRight(actor, s, v.spec, r.gate);
    if (!right.ok) fail(right.reason, 403);
    if (r.hash !== s.current_hash) fail("The spec changed after review was requested. Request review again.");
    const blockers = await openBlockers(s.id);
    if (blockers.length) fail(`${blockers.length} blocker finding(s) are still open. Accept or dismiss each with a reason first.`);
    const qa = await latestReport(s.id, r.hash, "qa");
    if (!qa?.body.ok) fail("QA has not passed on this version.");
  }
  await tx(async (c) => {
    await c.query("UPDATE reviews SET status = $2, decided_by = $3, decision_note = $4, decided_at = now() WHERE id = $1", [
      r.id,
      decision === "approve" ? "approved" : "changes_requested",
      actor.user.id,
      note,
    ]);
    if (r.gate === "pilot") {
      if (decision === "approve") await c.query("UPDATE studies SET status = 'approved', approved_hash = $2, updated_at = now() WHERE id = $1", [s.id, r.hash]);
      else await c.query("UPDATE studies SET status = 'draft', updated_at = now() WHERE id = $1", [s.id]);
    }
  });
  await audit(actor, decision === "approve" ? "review_approved" : "changes_requested", {
    studyId: s.id,
    hash: r.hash,
    detail: { gate: r.gate, note, self_approval: s.owner_id === actor.user.id },
  });
  return { gate: r.gate, decision };
}

// ---------------------------------------------------------------- running

export function studyLink(baseUrl, hash) {
  return `${baseUrl}/s/${hash.slice(0, 16)}/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`;
}

export async function startDeployment(actor, slug, phase, { prolific_study_id = null, completion_code = null } = {}, baseUrl = "") {
  if (actor.client !== "web") fail("Starting data collection is done by a person in the web app.", 403);
  const s = await loadStudy(actor, slug);
  if (!canEdit(actor, s)) fail("Only the owner or the lab head can start data collection.", 403);
  if (!s.approved_hash) fail("Nothing has been approved yet.");
  const v = await versionOf(s, s.approved_hash);
  const spec = v.spec;
  if (phase === "pilot" && s.status !== "approved") fail(`The pilot starts after approval (study is ${s.status}).`);
  if (phase === "main") {
    if (s.status !== "pilot_review") fail(`Main data collection starts after the pilot (study is ${s.status}).`);
    const ok = await one("SELECT id FROM reviews WHERE study_id = $1 AND hash = $2 AND gate = 'go_live' AND status = 'approved'", [s.id, v.hash]);
    if (!ok) fail("Go-live has not been approved for this version.");
  }
  const code = completion_code || spec.recruitment.completion_code || null;
  if (spec.recruitment.platform === "prolific" && !code) fail("Enter the Prolific completion code so participants get credited.");
  const maxN = phase === "pilot" ? pilotN(spec) : spec.recruitment.max_n;
  const reward = spec.recruitment.reward_per_participant ?? null;
  const dep = await tx(async (c) => {
    await c.query("UPDATE deployments SET status = 'closed', ended_at = now() WHERE study_id = $1 AND status IN ('active','paused')", [s.id]);
    const d = (
      await c.query(
        `INSERT INTO deployments (study_id, hash, phase, prolific_study_id, completion_code, max_n, reward, budget, started_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [s.id, v.hash, phase, prolific_study_id, code, maxN, reward, estimatedSpend(spec, maxN), actor.user.id],
      )
    ).rows[0];
    await c.query("UPDATE studies SET status = $2, live_hash = $3, status_note = NULL, updated_at = now() WHERE id = $1", [
      s.id,
      phase === "pilot" ? "piloting" : "live",
      phase === "main" ? v.hash : s.live_hash,
    ]);
    return d;
  });
  await audit(actor, phase === "pilot" ? "pilot_started" : "main_started", { studyId: s.id, hash: v.hash, detail: { max_n: maxN, prolific_study_id } });
  return {
    phase,
    max_n: maxN,
    budget: dep.budget,
    study_link: studyLink(baseUrl, v.hash),
    completion_code: code,
    instructions:
      `In Prolific: set the study URL to the link above (with the placeholders exactly as shown), set completion code ${code ?? "(none)"}, ` +
      `and ${phase === "pilot" ? `${maxN} places` : `places up to ${maxN}`}. Then publish it there.`,
  };
}

export async function setRunState(actor, slug, action, note = null) {
  const s = await loadStudy(actor, slug);
  const dep = await one("SELECT * FROM deployments WHERE study_id = $1 AND status IN ('active','paused') ORDER BY started_at DESC LIMIT 1", [s.id]);
  const pro = prolificClient(process.env.PROLIFIC_TOKEN);
  const prolificDo = async (fn) => {
    if (!pro || !dep?.prolific_study_id) return "Prolific not connected: do the same on Prolific by hand.";
    try {
      await fn(dep.prolific_study_id);
      return "Done on Prolific too.";
    } catch (e) {
      return `Prolific: ${e.message}`;
    }
  };
  let msg;
  if (action === "pause") {
    if (!canEdit(actor, s)) fail("Not allowed.", 403);
    if (!dep || dep.status !== "active") fail("Nothing is running.");
    msg = await prolificDo((id) => pro.pause(id));
    await q("UPDATE deployments SET status = 'paused', status_note = $2 WHERE id = $1", [dep.id, note ?? "Paused by hand."]);
    await q("UPDATE studies SET status = 'paused', status_note = $2, updated_at = now() WHERE id = $1", [s.id, note ?? "Paused by hand."]);
  } else if (action === "resume") {
    if (actor.client !== "web") fail("Resuming is done by a person in the web app.", 403);
    if (!(isLabHead(actor) || (s.owner_id === actor.user.id && actor.user.tier === "trusted"))) fail("The lab head resumes supervised studies.", 403);
    if (!dep || dep.status !== "paused") fail("Nothing is paused.");
    const stoppedByRule = /^Stopping rule|max_n/.test(dep.status_note ?? "");
    if (stoppedByRule && !note) fail("This was stopped by the preregistered rule or max N. Resuming is a deviation: give a reason.");
    msg = await prolificDo((id) => pro.start(id));
    await q("UPDATE deployments SET status = 'active', status_note = NULL WHERE id = $1", [dep.id]);
    await q("UPDATE studies SET status = $2, status_note = $3, updated_at = now() WHERE id = $1", [
      s.id,
      dep.phase === "pilot" ? "piloting" : "live",
      stoppedByRule ? `Resumed after automatic stop: ${note}` : null,
    ]);
  } else if (action === "close") {
    if (actor.client !== "web") fail("Closing is done by a person in the web app.", 403);
    if (!canEdit(actor, s)) fail("Not allowed.", 403);
    if (dep) await q("UPDATE deployments SET status = 'closed', ended_at = now() WHERE id = $1", [dep.id]);
    await q("UPDATE studies SET status = 'closed', status_note = $2, updated_at = now() WHERE id = $1", [s.id, note]);
    msg = "Closed. Remember to stop it on Prolific if it's still open there.";
  } else if (action === "end_pilot") {
    if (!canEdit(actor, s)) fail("Not allowed.", 403);
    if (!dep || dep.phase !== "pilot") fail("No pilot is running.");
    msg = await finishPilot(s, dep);
  } else fail(`Unknown action ${action}.`);
  await audit(actor, `run_${action}`, { studyId: s.id, hash: dep?.hash, detail: { note } });
  return { action, message: msg };
}

async function sessionsWithRows(depId) {
  const ss = (await q("SELECT id, levels, scored, minutes, condition, status FROM sessions WHERE deployment_id = $1 AND status = 'complete' ORDER BY completed_at", [depId])).rows;
  const trials = (await q("SELECT t.session_id, t.step, t.data FROM trials t JOIN sessions s ON s.id = t.session_id WHERE s.deployment_id = $1 AND s.status = 'complete' ORDER BY t.session_id, t.step, t.trial_index", [depId])).rows;
  const bySession = {};
  for (const t of trials) ((bySession[t.session_id] ??= {})[t.step] ??= []).push(t.data);
  return ss.map((x) => ({ ...x, rows: bySession[x.id] ?? {} }));
}

async function finishPilot(s, dep) {
  const v = await versionOf(s, dep.hash);
  const sessions = (await sessionsWithRows(dep.id)).filter((x) => x.scored);
  const results = runChecks(
    v.spec.pilot?.checks ?? [],
    sessions.map((x) => ({ rows: x.rows, measures: x.scored.measures, summaries: x.scored.summaries, excluded: x.scored.excluded, minutes: Number(x.minutes) })),
  );
  const failed = results.filter((r) => r.level === "blocker" && !r.pass).length;
  await storeReport(s, dep.hash, "pilot", { n_sessions: sessions.length, checks: results, blockers_failed: failed, ended_early: true }, null);
  const note = `Pilot ended by hand: ${sessions.length} sessions, ${failed} blocker check(s) failed.`;
  await q("UPDATE deployments SET status = 'completed', status_note = $2, ended_at = now() WHERE id = $1", [dep.id, note]);
  await q("UPDATE studies SET status = 'pilot_review', status_note = $2, updated_at = now() WHERE id = $1", [s.id, note]);
  return note;
}

// ---------------------------------------------------------------- status & data

export async function studyStatus(actor, slug) {
  const s = await loadStudy(actor, slug);
  const deployments = (await q("SELECT id, hash, phase, status, status_note, max_n, budget, prolific_study_id, started_at, ended_at FROM deployments WHERE study_id = $1 ORDER BY started_at DESC", [s.id])).rows;
  const active = deployments.find((d) => ["active", "paused"].includes(d.status)) ?? deployments[0] ?? null;
  let byCondition = [];
  let quality = [];
  let exclusionCounts = {};
  if (active) {
    byCondition = (
      await q(
        `SELECT condition,
                count(*) FILTER (WHERE status = 'started') AS in_progress,
                count(*) FILTER (WHERE status = 'complete') AS complete,
                count(*) FILTER (WHERE status = 'complete' AND (scored->>'excluded')::boolean = false) AS included,
                count(*) FILTER (WHERE status = 'declined') AS declined
         FROM sessions WHERE deployment_id = $1 GROUP BY condition ORDER BY condition`,
        [active.id],
      )
    ).rows;
    quality = (
      await q("SELECT id AS session_id, quality_flags FROM sessions WHERE deployment_id = $1 AND jsonb_array_length(coalesce(quality_flags, '[]')) > 0 ORDER BY completed_at DESC LIMIT 20", [active.id])
    ).rows;
    const ex = (await q("SELECT scored->'exclusions' AS e FROM sessions WHERE deployment_id = $1 AND status = 'complete' AND scored IS NOT NULL", [active.id])).rows;
    for (const r of ex) for (const [k, v] of Object.entries(r.e ?? {})) if (v === true || v === "missing") exclusionCounts[k] = (exclusionCounts[k] ?? 0) + 1;
  }
  const stopChecks = active
    ? (await q("SELECT n_included, n_x, n_y, bf10, decision, reason, created_at FROM stop_checks WHERE deployment_id = $1 ORDER BY id DESC LIMIT 10", [active.id])).rows
    : [];
  const pilot = s.approved_hash ? await latestReport(s.id, s.approved_hash, "pilot") : null;
  const findings = (await q("SELECT count(*) FILTER (WHERE status = 'open' AND severity = 'blocker') AS open_blockers, count(*) FILTER (WHERE status = 'open' AND severity IS NOT NULL) AS open_findings FROM comments WHERE study_id = $1", [s.id])).rows[0];
  return {
    study: s.slug,
    title: s.title,
    owner: s.owner_name,
    status: s.status,
    status_note: s.status_note,
    current: s.current_hash ? shortHash(s.current_hash) : null,
    approved: s.approved_hash ? shortHash(s.approved_hash) : null,
    live: s.live_hash ? shortHash(s.live_hash) : null,
    deployment: active ? { ...active, hash: shortHash(active.hash) } : null,
    by_condition: byCondition,
    exclusion_counts: exclusionCounts,
    stop_checks: stopChecks,
    pilot_report: pilot?.body ?? null,
    quality_flags: quality,
    open_findings: Number(findings.open_findings),
    open_blockers: Number(findings.open_blockers),
  };
}

/**
 * Preview sessions (researcher click-throughs) for the most recently previewed
 * version. Kept apart from pilot and main data; scored on the fly, including
 * unfinished sessions, so the data format can be checked before a pilot.
 */
async function previewData(s, { kind, offset, limit }) {
  const latest = await one("SELECT hash FROM sessions WHERE study_id = $1 AND phase = 'preview' ORDER BY started_at DESC LIMIT 1", [s.id]);
  if (!latest) fail("No preview sessions yet. Open a preview link and click through a condition first.", 404);
  const v = await versionOf(s, latest.hash);
  const ss = (
    await q("SELECT id, levels, condition, status FROM sessions WHERE study_id = $1 AND phase = 'preview' AND hash = $2 ORDER BY started_at DESC LIMIT 50", [
      s.id,
      latest.hash,
    ])
  ).rows;
  const trials = (
    await q("SELECT session_id, step, data FROM trials WHERE session_id = ANY($1) ORDER BY session_id, step, trial_index", [ss.map((x) => x.id)])
  ).rows;
  const bySession = {};
  for (const t of trials) ((bySession[t.session_id] ??= {})[t.step] ??= []).push(t.data);
  const sessions = ss.map((x) => {
    const rows = bySession[x.id] ?? {};
    let scored;
    try {
      scored = scoreParticipant(v.spec, { levels: x.levels, rows });
    } catch {
      scored = { measures: {}, summaries: {}, exclusions: {}, excluded: null };
    }
    return { session_id: x.id, condition: x.condition, levels: x.levels, rows, scored, status: x.status === "started" ? "unfinished" : x.status };
  });
  const note = `Preview data for version ${shortHash(v.hash)}: researcher click-throughs, never analysed. Unfinished sessions are included.`;
  const participants = participantsCsv(v.spec, sessions);
  if (kind === "participants") return { phase: "preview", hash: shortHash(v.hash), n_sessions: sessions.length, note, csv: participants };
  return { phase: "preview", hash: shortHash(v.hash), note, ...pageCsv(trialsCsv(v.spec, sessions), offset, limit) };
}

function pageCsv(full, offset, limit) {
  const lines = full.split("\n");
  const body = lines.slice(1).filter(Boolean);
  const page = body.slice(offset, offset + limit);
  return { n_rows: body.length, offset, returned: page.length, more: offset + page.length < body.length, csv: [lines[0], ...page].join("\n") + "\n" };
}

/** Pseudonymised data: session ids only. Prolific IDs are never returned. */
export async function getData(actor, slug, { phase = "main", kind = "participants", offset = 0, limit = 5000 } = {}) {
  const s = await loadStudy(actor, slug);
  if (phase === "preview") return previewData(s, { kind, offset, limit });
  const deps = (await q("SELECT id, hash FROM deployments WHERE study_id = $1 AND phase = $2 ORDER BY started_at", [s.id, phase])).rows;
  if (!deps.length) fail(`No ${phase} data yet.`, 404);
  const v = await versionOf(s, deps.at(-1).hash);
  const sessions = [];
  for (const d of deps) {
    for (const x of await sessionsWithRows(d.id)) {
      if (!x.scored) continue;
      sessions.push({ session_id: x.id, condition: x.condition, levels: x.levels, rows: x.rows, scored: x.scored, status: x.status });
    }
  }
  const participants = participantsCsv(v.spec, sessions);
  const dataHash = sha256(participants).slice(0, 16);
  if (kind === "participants") return { data_hash: dataHash, n_sessions: sessions.length, csv: participants };
  const full = trialsCsv(v.spec, sessions);
  const lines = full.split("\n");
  const header = lines[0];
  const body = lines.slice(1).filter(Boolean);
  const page = body.slice(offset, offset + limit);
  return {
    data_hash: dataHash,
    n_rows: body.length,
    offset,
    returned: page.length,
    more: offset + page.length < body.length,
    csv: [header, ...page].join("\n") + "\n",
  };
}

export async function report(actor, slug, kind, { hash = null } = {}) {
  const s = await loadStudy(actor, slug);
  if (kind === "drift") {
    if (!s.approved_hash) return { kind, summary: "Nothing approved yet, so nothing to drift from." };
    const approved = await versionOf(s, s.approved_hash);
    const cur = await versionOf(s, s.live_hash ?? s.current_hash);
    const d = diffSpecs(approved.spec, cur.spec);
    const deviations = (await q("SELECT at, action, detail FROM audit_log WHERE study_id = $1 AND action IN ('auto_pause_stop_rule','run_resume','auto_pause_max_n') ORDER BY at", [s.id])).rows;
    return {
      kind,
      approved: shortHash(approved.hash),
      compared_with: shortHash(cur.hash),
      drift: d.major.length > 0,
      design_changes: d.major.map((x) => x.sentence),
      wording_changes: d.minor.map((x) => x.sentence),
      run_events: deviations,
    };
  }
  const v = await versionOf(s, hash ?? s.approved_hash ?? s.current_hash);
  if (kind === "prereg") {
    const sim = await latestReport(s.id, v.hash, "simulation");
    return { kind, hash: shortHash(v.hash), format: "markdown", content: generatePrereg(v.spec, { hash: shortHash(v.hash), simulation: sim?.body }) };
  }
  if (kind === "r_script") return { kind, hash: shortHash(v.hash), format: "r", content: generateRScript(v.spec, { hash: shortHash(v.hash) }) };
  if (["qa", "simulation", "pilot"].includes(kind)) {
    const r = await latestReport(s.id, v.hash, kind);
    return { kind, hash: shortHash(v.hash), report: r?.body ?? null, created_at: r?.created_at ?? null };
  }
  fail(`Unknown report kind "${kind}".`);
}

// ---------------------------------------------------------------- comments & AI review

export async function listComments(actor, slug) {
  const s = await loadStudy(actor, slug);
  return (
    await q(
      `SELECT c.*, u.name AS author_name, r.name AS resolved_by_name FROM comments c
       LEFT JOIN users u ON u.id = c.author_id LEFT JOIN users r ON r.id = c.resolved_by
       WHERE c.study_id = $1 ORDER BY (c.status = 'open') DESC, c.created_at DESC`,
      [s.id],
    )
  ).rows;
}

export async function addComment(actor, slug, { body, severity = null, path = null }) {
  const s = await loadStudy(actor, slug);
  if (!body?.trim()) fail("Empty comment.");
  const c = await one(
    "INSERT INTO comments (study_id, hash, author_id, via, body, severity, path, source, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'human',$8) RETURNING id",
    [s.id, s.current_hash, actor.user.id, actor.client, body.trim(), severity, path, severity ? "open" : "note"],
  );
  return { id: c.id };
}

export async function resolveComment(actor, slug, id, { status, resolution }) {
  const s = await loadStudy(actor, slug);
  if (!["accepted", "dismissed"].includes(status)) fail('status must be "accepted" or "dismissed".');
  if (!resolution?.trim()) fail("Give a one-line reason. Dismissing is fine; silently dismissing isn't.");
  const r = await q("UPDATE comments SET status = $3, resolution = $4, resolved_by = $5 WHERE id = $1 AND study_id = $2 AND status = 'open' RETURNING id", [
    id,
    s.id,
    status,
    resolution.trim(),
    actor.user.id,
  ]);
  if (!r.rowCount) fail("No open finding with that id.");
  await audit(actor, `finding_${status}`, { studyId: s.id, detail: { id, resolution } });
  return { id, status };
}

async function queueAiTask(studyId, hash, kind) {
  await q("UPDATE ai_tasks SET status = 'superseded' WHERE study_id = $1 AND kind = $2 AND status IN ('queued','claimed')", [studyId, kind]);
  await q("INSERT INTO ai_tasks (study_id, hash, kind) VALUES ($1,$2,$3)", [studyId, hash, kind]);
}

const RUBRICS = {
  verification:
    "You are the lab's independent study reviewer. You did not write this study. Find bugs a careful supervisor would catch on a click-through: " +
    "instructions that contradict the task (keys, scale direction, what to judge), conditions that differ in unintended ways or fail to differ, " +
    "confidence labels reversed, feedback shown in the wrong condition, practice recorded as data, exclusion thresholds that don't fit the staircase target, " +
    "analysis DV not matching the hypothesis, pay or duration problems, typos, ambiguous attention checks, debriefs that reveal the wrong hypothesis. " +
    "Report at most 10 findings, most important first. Use severity 'blocker' only for things that would invalidate data or harm participants. " +
    "For each finding give path (spec path or step id), message, suggestion and your confidence (0-1). Say 'no issues found' rather than inventing issues.",
  design_critic:
    "You are the lab's design critic. Review the design, not the code. At most 5 points, ranked, each tagged 'concern' or 'consider'. " +
    "Look for confounds and alternative explanations, whether the DV measures the construct (M-ratio vs AUROC2 vs meta-d'), within vs between tradeoffs, " +
    "missing manipulation checks, analyses that don't test the stated hypothesis, and feasibility given the simulation. " +
    "If the owner is a supervised student, phrase points as questions that make them think; otherwise be direct. " +
    "Never invent citations; you may say 'check prior work on X'. Apply the lab standards below.",
};

export async function nextAiTask(actor) {
  const t = await one(
    `UPDATE ai_tasks SET status = 'claimed', claimed_at = now()
     WHERE id = (
       SELECT a.id FROM ai_tasks a JOIN studies s ON s.id = a.study_id
       WHERE ($1 OR s.owner_id = $2)
         AND (a.status = 'queued' OR (a.status = 'claimed' AND a.claimed_at < now() - interval '30 minutes'))
       ORDER BY a.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [isLabHead(actor), actor.user.id],
  );
  if (!t) return { task: null, message: "No review tasks waiting." };
  const s = await one("SELECT s.*, u.tier AS owner_tier, u.name AS owner_name FROM studies s JOIN users u ON u.id = s.owner_id WHERE s.id = $1", [t.study_id]);
  const v = await one("SELECT * FROM spec_versions WHERE hash = $1", [t.hash]);
  const qa = await latestReport(s.id, t.hash, "qa");
  const sim = await latestReport(s.id, t.hash, "simulation");
  const standards = await getLabStandards();
  const blocks = [...new Set(Object.values(v.spec.blocks))].map((ref) => ({ ref, notes: getBlock(ref)?.reviewerNotes }));
  return {
    task: {
      id: t.id,
      kind: t.kind,
      study: s.slug,
      title: s.title,
      owner_tier: s.owner_tier,
      mode: s.owner_tier === "supervised" ? "teaching" : "direct",
      hash: shortHash(t.hash),
      instructions: RUBRICS[t.kind] ?? RUBRICS.verification,
      spec_yaml: v.yaml,
      validation_warnings: v.validation.warnings,
      qa: qa?.body ?? null,
      simulation: sim?.body ?? null,
      block_notes: blocks,
      lab_standards: standards,
      estimated_minutes: Math.round(estimateMinutes(v.spec)),
      submit_with: 'review tool, action "submit_findings", task_id and findings[]',
    },
  };
}

export async function submitAiFindings(actor, taskId, findings) {
  const t = await one("SELECT * FROM ai_tasks WHERE id = $1 AND status = 'claimed'", [taskId]);
  if (!t) fail("No claimed task with that id (it may have been superseded by a newer version).");
  const s = await loadStudy(actor, (await one("SELECT slug FROM studies WHERE id = $1", [t.study_id])).slug);
  const list = Array.isArray(findings) ? findings.slice(0, 15) : [];
  const source = t.kind === "design_critic" ? "ai_critic" : "ai_reviewer";
  for (const f of list) {
    const sev = ["blocker", "concern", "consider"].includes(f.severity) ? f.severity : "consider";
    const body = [f.message, f.suggestion ? `Suggestion: ${f.suggestion}` : null, typeof f.confidence === "number" ? `(confidence ${f.confidence})` : null]
      .filter(Boolean)
      .join("\n");
    if (!body.trim()) continue;
    await q("INSERT INTO comments (study_id, hash, author_id, via, body, severity, path, source, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open')", [
      s.id,
      t.hash,
      actor.user.id,
      actor.client,
      body,
      sev,
      f.path ?? null,
      source,
    ]);
  }
  await q("UPDATE ai_tasks SET status = 'done', done_at = now() WHERE id = $1", [t.id]);
  if (!list.length) {
    await q("INSERT INTO comments (study_id, hash, author_id, via, body, source, status) VALUES ($1,$2,$3,$4,$5,$6,'note')", [
      s.id,
      t.hash,
      actor.user.id,
      actor.client,
      `${t.kind === "design_critic" ? "Design critic" : "AI verification"}: no issues found. (This is not a pass; still click through each condition.)`,
      source,
    ]);
  }
  await audit(actor, "ai_findings_submitted", { studyId: s.id, hash: t.hash, detail: { kind: t.kind, n: list.length } });
  return { recorded: list.length, study: s.slug };
}

// ---------------------------------------------------------------- saved items

export async function saveItem(actor, slug, { kind, title = null, content, exploratory = false, data_hash = null }) {
  const s = await loadStudy(actor, slug);
  if (!["analysis", "note", "codes"].includes(kind)) fail('kind must be "analysis", "note" or "codes".');
  if (!content?.trim()) fail("Nothing to save.");
  const r = await one(
    "INSERT INTO saved_items (study_id, kind, title, content, data_hash, exploratory, created_by, created_via) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at",
    [s.id, kind, title, content, data_hash, Boolean(exploratory), actor.user.id, actor.client],
  );
  await audit(actor, "item_saved", { studyId: s.id, detail: { kind, title, exploratory, data_hash } });
  return { id: r.id, saved_at: r.created_at, note: kind === "analysis" && exploratory ? "Logged as exploratory." : undefined };
}

export async function listSaved(actor, slug) {
  const s = await loadStudy(actor, slug);
  return (await q("SELECT i.*, u.name AS author FROM saved_items i LEFT JOIN users u ON u.id = i.created_by WHERE study_id = $1 ORDER BY created_at DESC", [s.id])).rows;
}

// ---------------------------------------------------------------- people & settings

export async function getLabStandards() {
  return (await one("SELECT value FROM lab_settings WHERE key = 'lab_standards'"))?.value?.text ?? "";
}

export async function setLabStandards(actor, text) {
  if (!isLabHead(actor)) fail("Only the lab head edits lab standards.", 403);
  await q("INSERT INTO lab_settings (key, value) VALUES ('lab_standards', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [j({ text })]);
  await audit(actor, "lab_standards_updated");
}

export async function personSummary(actor, name = null) {
  const target = name
    ? await one("SELECT * FROM users WHERE name ILIKE $1 LIMIT 1", [`%${name}%`])
    : actor.user;
  if (!target) fail(`No person matching "${name}".`, 404);
  if (!isLabHead(actor) && target.id !== actor.user.id) fail("You can only see your own summary.", 403);
  const studies = (await q("SELECT slug, title, status, status_note, updated_at FROM studies WHERE owner_id = $1 ORDER BY updated_at DESC", [target.id])).rows;
  const since = (await one("SELECT max(at) AS at FROM audit_log WHERE action = 'meeting_marked' AND detail->>'person' = $1", [target.id]))?.at ?? null;
  const activity = (
    await q(
      `SELECT a.at, a.action, a.client, s.slug FROM audit_log a LEFT JOIN studies s ON s.id = a.study_id
       WHERE s.owner_id = $1 AND ($2::timestamptz IS NULL OR a.at > $2) ORDER BY a.at DESC LIMIT 40`,
      [target.id, since],
    )
  ).rows;
  const openFindings = (
    await q(
      `SELECT s.slug, c.severity, c.source, left(c.body, 160) AS body FROM comments c JOIN studies s ON s.id = c.study_id
       WHERE s.owner_id = $1 AND c.status = 'open' AND c.severity IS NOT NULL ORDER BY c.created_at`,
      [target.id],
    )
  ).rows;
  const dismissed = (
    await q(
      `SELECT s.slug, left(c.body, 120) AS finding, c.resolution FROM comments c JOIN studies s ON s.id = c.study_id
       WHERE s.owner_id = $1 AND c.status = 'dismissed' AND ($2::timestamptz IS NULL OR c.created_at > $2) ORDER BY c.created_at DESC LIMIT 20`,
      [target.id, since],
    )
  ).rows;
  return { person: target.name, tier: target.tier, since_last_meeting: since, studies, open_findings: openFindings, dismissed_ai_points: dismissed, recent_activity: activity };
}

export async function markMeeting(actor, userId) {
  if (!isLabHead(actor)) fail("Only the lab head marks meetings.", 403);
  await audit(actor, "meeting_marked", { detail: { person: userId } });
}

export function catalog() {
  return blockCatalog();
}

export { stepId };

// ---------------------------------------------------------------- page data

/** Everything the study page shows, in one call. */
export async function studyPageData(actor, slug) {
  const s = await loadStudy(actor, slug);
  const cur = s.current_hash ? await versionOf(s, null) : null;
  const [status, versions, comments, saved] = await Promise.all([
    studyStatus(actor, slug),
    listVersions(actor, slug),
    listComments(actor, slug),
    listSaved(actor, slug),
  ]);
  const qa = cur ? await latestReport(s.id, cur.hash, "qa") : null;
  const sim = cur ? await latestReport(s.id, cur.hash, "simulation") : null;
  const review = await one(
    `SELECT r.*, u.name AS requested_by_name FROM reviews r LEFT JOIN users u ON u.id = r.requested_by
     WHERE r.study_id = $1 ORDER BY r.created_at DESC LIMIT 1`,
    [s.id],
  );
  const goLiveApproved = s.approved_hash
    ? Boolean(await one("SELECT 1 FROM reviews WHERE study_id = $1 AND hash = $2 AND gate = 'go_live' AND status = 'approved'", [s.id, s.approved_hash]))
    : false;
  let parentDiff = null;
  if (cur?.parent_hash) {
    const p = await one("SELECT spec FROM spec_versions WHERE hash = $1", [cur.parent_hash]);
    if (p) parentDiff = diffSpecs(p.spec, cur.spec);
  }
  let approvedDiff = null;
  if (s.approved_hash && cur && s.approved_hash !== cur.hash) {
    const a = await one("SELECT spec FROM spec_versions WHERE hash = $1", [s.approved_hash]);
    if (a) approvedDiff = diffSpecs(a.spec, cur.spec);
  }
  let approve = null;
  if (review?.status === "open") {
    const rv = await one("SELECT spec FROM spec_versions WHERE hash = $1", [review.hash]);
    approve = await approvalRight(actor, s, rv.spec, review.gate);
  }
  const aiTasks = (await q("SELECT kind, status, created_at FROM ai_tasks WHERE study_id = $1 AND status IN ('queued','claimed') ORDER BY created_at", [s.id])).rows;
  const spend = cur?.validation.ok
    ? { pilot: estimatedSpend(cur.spec, pilotN(cur.spec)), main: estimatedSpend(cur.spec, cur.spec.recruitment.max_n), currency: cur.spec.recruitment.currency }
    : null;
  return {
    study: s,
    current: cur,
    status,
    versions,
    comments,
    saved,
    qa: qa?.body ?? null,
    qaAt: qa?.created_at ?? null,
    sim: sim?.body ?? null,
    simAt: sim?.created_at ?? null,
    review,
    goLiveApproved,
    parentDiff,
    approvedDiff,
    approve,
    aiTasks,
    spend,
    canEdit: canEdit(actor, s),
    conditions: cur?.validation.ok ? listConditions(cur.spec).map((c) => c.key) : [],
  };
}

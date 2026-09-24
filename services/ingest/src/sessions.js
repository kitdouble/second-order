// Session lifecycle: start (with condition assignment), trials, completion,
// scoring, stopping rules and pilot completion.
import crypto from "node:crypto";
import {
  listConditions,
  parseConditionKey,
  assignCondition,
  targetPerCondition,
  scoreParticipant,
  primaryTest,
  stoppingDecision,
  runChecks,
  compile,
} from "@so/core";
import { prolificClient } from "@so/core/prolific";
import { q, tx } from "./db.js";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newId = () => crypto.randomBytes(12).toString("base64url");

export class UserFacing extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function loadVersion(hash) {
  const r = await q("SELECT hash, study_id, spec FROM spec_versions WHERE hash = $1", [hash]);
  return r.rows[0] ?? null;
}

async function audit(client, action, studyId, hash, detail) {
  await client.query(
    "INSERT INTO audit_log (client, action, study_id, hash, detail) VALUES ('platform', $1, $2, $3, $4)",
    [action, studyId, hash, JSON.stringify(detail ?? {})],
  );
}

/** Starts (or restarts) a session. Returns what the runtime needs to run. */
export async function startSession(start) {
  // Links carry a 16+ char prefix of the hash; resolve it.
  const vr = await q("SELECT hash FROM spec_versions WHERE hash LIKE $1 || '%' LIMIT 2", [start.hash]);
  if (vr.rows.length !== 1) throw new UserFacing("not_found", "This study link is not valid.", 404);
  const version = await loadVersion(vr.rows[0].hash);
  const spec = version.spec;
  const conds = listConditions(spec);

  // Researcher preview: any version, flagged and kept out of all analyses.
  if (start.preview) {
    const t = await q("SELECT hash FROM preview_tokens WHERE token_hash = $1 AND expires_at > now()", [sha256(start.preview)]);
    if (!t.rows.length || t.rows[0].hash !== version.hash) throw new UserFacing("preview_expired", "This preview link has expired. Make a new one.", 403);
    const cond = conds.find((c) => c.key === start.cond) ?? conds[Math.floor(Math.random() * conds.length)];
    const id = `prev_${newId()}`;
    await q(
      "INSERT INTO sessions (id, study_id, hash, phase, condition, levels) VALUES ($1, $2, $3, 'preview', $4, $5)",
      [id, version.study_id, version.hash, cond.key, JSON.stringify(cond.levels)],
    );
    return { session_id: id, condition: cond.key, phase: "preview", seed: id, plan: compile(spec, cond.levels, id) };
  }

  const dep = (
    await q("SELECT * FROM deployments WHERE hash = $1 AND status = 'active' ORDER BY started_at DESC LIMIT 1", [version.hash])
  ).rows[0];
  if (!dep) throw new UserFacing("not_active", "This study is not taking participants at the moment.", 409);
  if (spec.recruitment.platform === "prolific" && !start.pid) {
    throw new UserFacing("no_pid", "Please open this study from Prolific so your participation can be recorded.", 400);
  }

  return tx(async (c) => {
    // One run per participant per study. A reload restarts the same session cleanly.
    if (start.pid) {
      const prev = await c.query(
        `SELECT s.id, s.status, s.condition, s.levels, s.meta FROM participant_ids p JOIN sessions s ON s.id = p.session_id
         WHERE p.study_id = $1 AND p.prolific_pid = $2`,
        [version.study_id, start.pid],
      );
      if (prev.rows.length) {
        const s = prev.rows[0];
        if (s.status !== "started") throw new UserFacing("already_done", "You have already taken part in this study. Thank you!", 409);
        await c.query("DELETE FROM trials WHERE session_id = $1", [s.id]);
        const restarts = (s.meta?.restarts ?? 0) + 1;
        await c.query("UPDATE sessions SET started_at = now(), meta = jsonb_set(coalesce(meta, '{}'), '{restarts}', $2::jsonb) WHERE id = $1", [
          s.id,
          JSON.stringify(restarts),
        ]);
        return { session_id: s.id, condition: s.condition, phase: dep.phase, seed: s.id, plan: compile(spec, s.levels, s.id), restarted: true };
      }
    }

    // Serialise assignment per deployment so counts are consistent.
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [dep.id]);
    const counts = await c.query(
      `SELECT condition,
              count(*) FILTER (WHERE status = 'complete' AND coalesce((scored->>'excluded')::boolean, false) = false) AS included,
              count(*) FILTER (WHERE status = 'started' AND started_at > now() - make_interval(mins => $2)) AS inflight,
              count(*) FILTER (WHERE status <> 'started' OR started_at <= now() - make_interval(mins => $2)) AS finished,
              count(*) AS total
       FROM sessions WHERE deployment_id = $1 GROUP BY condition`,
      [dep.id, Math.ceil(spec.recruitment.est_minutes * 2)],
    );
    const byCond = Object.fromEntries(counts.rows.map((r) => [r.condition, { included: +r.included, inflight: +r.inflight, finished: +r.finished }]));
    const totalStarted = counts.rows.reduce((a, r) => a + Number(r.total), 0);
    if (totalStarted >= dep.max_n) throw new UserFacing("full", "This study is full. Thank you for your interest.", 409);

    const target = dep.phase === "pilot" ? spec.pilot?.n_per_condition ?? 6 : targetPerCondition(spec, conds.length);
    if (dep.phase === "pilot" && conds.every((cd) => (byCond[cd.key]?.included ?? 0) + (byCond[cd.key]?.inflight ?? 0) >= target)) {
      throw new UserFacing("full", "This study is full. Thank you for your interest.", 409);
    }
    const finished = Object.values(byCond).reduce((a, r) => a + r.finished, 0);
    const included = Object.values(byCond).reduce((a, r) => a + r.included, 0);
    const yieldRate = finished >= 10 ? included / finished : 0.8;
    const { key } = assignCondition(
      conds.map((cd) => cd.key),
      byCond,
      target,
      yieldRate,
      crypto.randomInt(0, 2 ** 32) / 2 ** 32,
      spec.design.assignment.method,
    );

    const id = newId();
    const levels = parseConditionKey(key);
    await c.query(
      "INSERT INTO sessions (id, study_id, hash, deployment_id, phase, condition, levels, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, version.study_id, version.hash, dep.id, dep.phase, key, JSON.stringify(levels), JSON.stringify({ restarts: 0 })],
    );
    if (start.pid) {
      await c.query(
        "INSERT INTO participant_ids (session_id, study_id, prolific_pid, prolific_session_id, prolific_study_id) VALUES ($1,$2,$3,$4,$5)",
        [id, version.study_id, start.pid, start.prolific_session_id ?? null, start.prolific_study_id ?? null],
      );
    }
    return { session_id: id, condition: key, phase: dep.phase, seed: id, plan: compile(spec, levels, id) };
  });
}

export async function insertTrials({ session_id, trials }) {
  const s = await q("SELECT status FROM sessions WHERE id = $1", [session_id]);
  if (!s.rows.length) throw new UserFacing("no_session", "Unknown session.", 404);
  if (s.rows[0].status !== "started") throw new UserFacing("closed", "This session has already finished.", 409);
  const values = [];
  const params = [];
  trials.forEach((t, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb)`);
    params.push(session_id, t.step, t.trial_index, JSON.stringify(t.data));
  });
  const r = await q(
    `INSERT INTO trials (session_id, step, trial_index, data) VALUES ${values.join(", ")}
     ON CONFLICT (session_id, step, trial_index) DO NOTHING`,
    params,
  );
  return { accepted: r.rowCount, duplicates: trials.length - r.rowCount };
}

/** Loads a session's trial rows grouped by step, in order. */
export async function sessionRows(sessionId, client = null) {
  const run = client ? (t, p) => client.query(t, p) : q;
  const r = await run("SELECT step, data FROM trials WHERE session_id = $1 ORDER BY step, trial_index", [sessionId]);
  const rows = {};
  for (const row of r.rows) (rows[row.step] ??= []).push(row.data);
  return rows;
}

function qualityFlags(meta, minutes, spec) {
  const flags = [];
  if (meta?.hidden_count > 3) flags.push(`Left the tab ${meta.hidden_count} times.`);
  if (meta?.refresh_hz && (meta.refresh_hz < 50 || meta.refresh_hz > 250)) flags.push(`Unusual refresh rate (${Math.round(meta.refresh_hz)} Hz).`);
  if (meta?.dropped_frame_prop > 0.1) flags.push(`${Math.round(meta.dropped_frame_prop * 100)}% of stimulus frames were late.`);
  if (minutes && minutes < spec.recruitment.est_minutes * 0.35) flags.push(`Finished in ${minutes.toFixed(1)} min (estimate ${spec.recruitment.est_minutes}).`);
  if (meta?.restarts > 0) flags.push(`Restarted ${meta.restarts} time(s).`);
  return flags;
}

/** Completes a session: scores it, then runs pilot or stopping-rule checks. */
export async function completeSession(sessionId, { status = "complete", minutes = null, meta = {} } = {}) {
  const s = (await q("SELECT * FROM sessions WHERE id = $1", [sessionId])).rows[0];
  if (!s) throw new UserFacing("no_session", "Unknown session.", 404);
  const dep = s.deployment_id ? (await q("SELECT * FROM deployments WHERE id = $1", [s.deployment_id])).rows[0] : null;
  const redirect = dep?.completion_code ? `https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(dep.completion_code)}` : null;
  if (s.status !== "started") return { already: true, redirect_url: s.status === "complete" ? redirect : null };

  const version = await loadVersion(s.hash);
  const spec = version.spec;
  const rows = await sessionRows(sessionId);
  let scored = null;
  if (status === "complete") {
    scored = scoreParticipant(spec, { levels: s.levels, rows });
  }
  const mergedMeta = { ...(s.meta ?? {}), ...(meta ?? {}) };
  const flags = qualityFlags(mergedMeta, minutes, spec);
  await q(
    "UPDATE sessions SET status = $2, completed_at = now(), minutes = $3, meta = $4, scored = $5, quality_flags = $6 WHERE id = $1",
    [sessionId, status, minutes, JSON.stringify(mergedMeta), JSON.stringify(scored), JSON.stringify(flags)],
  );

  let check = null;
  if (dep && status === "complete") {
    if (dep.phase === "main") check = await runStopCheck(dep, spec);
    if (dep.phase === "pilot") check = await runPilotCompletion(dep, spec);
  }
  return { redirect_url: status === "complete" ? redirect : null, check: check?.decision ?? null };
}

async function pauseOnProlific(dep) {
  const client = prolificClient(process.env.PROLIFIC_TOKEN);
  if (!client || !dep.prolific_study_id) return "Prolific not connected; pause it there by hand.";
  try {
    await client.pause(dep.prolific_study_id);
    return "Paused on Prolific.";
  } catch (e) {
    return `Could not pause on Prolific: ${e.message}`;
  }
}

async function participantsFor(client, depId) {
  const r = await client.query(
    "SELECT id, levels, scored FROM sessions WHERE deployment_id = $1 AND status = 'complete' AND scored IS NOT NULL ORDER BY completed_at",
    [depId],
  );
  return r.rows.map((x) => ({ session_id: x.id, levels: x.levels, scored: x.scored }));
}

/** Checks the preregistered stopping rule at each check_every boundary. */
export async function runStopCheck(dep, spec) {
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':stop'))", [dep.id]);
    const current = (await c.query("SELECT status FROM deployments WHERE id = $1", [dep.id])).rows[0];
    if (current.status !== "active") return null;
    const people = await participantsFor(c, dep.id);
    const included = people.filter((p) => !p.scored.excluded).length;
    const completes = people.length;

    // Hard cap on recruitment regardless of the rule.
    if (completes >= dep.max_n) {
      const note = `Reached max_n (${dep.max_n}). ${await pauseOnProlific(dep)}`;
      await c.query("UPDATE deployments SET status = 'paused', status_note = $2 WHERE id = $1", [dep.id, note]);
      await c.query("UPDATE studies SET status = 'paused', status_note = $2, updated_at = now() WHERE id = $1", [dep.study_id, note]);
      await audit(c, "auto_pause_max_n", dep.study_id, dep.hash, { completes });
      return { decision: "stop_max" };
    }
    const stop = spec.analysis?.stopping;
    if (!stop) return null;
    const last = (await c.query("SELECT n_included FROM stop_checks WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1", [dep.id])).rows[0];
    if (included - (last?.n_included ?? 0) < stop.check_every) return null;

    const test = primaryTest(spec, people);
    const d = stoppingDecision(spec, test);
    await c.query(
      "INSERT INTO stop_checks (study_id, deployment_id, n_included, n_x, n_y, bf10, decision, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [dep.study_id, dep.id, included, test?.n_x ?? null, test?.n_y ?? null, test?.bf10 ?? null, d.decision, d.reason],
    );
    if (d.decision !== "continue") {
      const note = `Stopping rule: ${d.reason} ${await pauseOnProlific(dep)}`;
      await c.query("UPDATE deployments SET status = 'paused', status_note = $2 WHERE id = $1", [dep.id, note]);
      await c.query("UPDATE studies SET status = 'paused', status_note = $2, updated_at = now() WHERE id = $1", [dep.study_id, note]);
      await audit(c, "auto_pause_stop_rule", dep.study_id, dep.hash, { ...d, bf10: test?.bf10, included });
    }
    return d;
  });
}

/** Ends the pilot once every condition has its pilot N, and runs the pilot checks. */
export async function runPilotCompletion(dep, spec) {
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1 || ':pilot'))", [dep.id]);
    const current = (await c.query("SELECT status FROM deployments WHERE id = $1", [dep.id])).rows[0];
    if (current.status !== "active") return null;
    const target = spec.pilot?.n_per_condition ?? 6;
    const counts = await c.query(
      "SELECT condition, count(*)::int AS n FROM sessions WHERE deployment_id = $1 AND status = 'complete' GROUP BY condition",
      [dep.id],
    );
    const byCond = Object.fromEntries(counts.rows.map((r) => [r.condition, r.n]));
    if (!listConditions(spec).every((cd) => (byCond[cd.key] ?? 0) >= target)) return null;

    const sess = await c.query(
      "SELECT id, levels, scored, minutes FROM sessions WHERE deployment_id = $1 AND status = 'complete' AND scored IS NOT NULL",
      [dep.id],
    );
    const sessions = [];
    for (const r of sess.rows) {
      const rows = await sessionRows(r.id, c);
      sessions.push({ rows, measures: r.scored.measures, summaries: r.scored.summaries, excluded: r.scored.excluded, minutes: Number(r.minutes) });
    }
    const results = runChecks(spec.pilot?.checks ?? [], sessions);
    const blockersFailed = results.filter((r) => r.level === "blocker" && !r.pass).length;
    await c.query("INSERT INTO reports (study_id, hash, kind, body) VALUES ($1, $2, 'pilot', $3)", [
      dep.study_id,
      dep.hash,
      JSON.stringify({ n_sessions: sessions.length, by_condition: byCond, checks: results, blockers_failed: blockersFailed }),
    ]);
    const note = `Pilot complete: ${sessions.length} sessions, ${blockersFailed} blocker check(s) failed. ${await pauseOnProlific(dep)}`;
    await c.query("UPDATE deployments SET status = 'completed', status_note = $2, ended_at = now() WHERE id = $1", [dep.id, note]);
    await c.query("UPDATE studies SET status = 'pilot_review', status_note = $2, updated_at = now() WHERE id = $1", [dep.study_id, note]);
    await audit(c, "pilot_complete", dep.study_id, dep.hash, { blockers_failed: blockersFailed });
    return { decision: "pilot_complete" };
  });
}

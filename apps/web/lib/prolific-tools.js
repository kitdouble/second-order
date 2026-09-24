// Agent-operable Prolific actions, always inside the envelope a human set
// when starting data collection. Prolific IDs never leave this module.
import { prolificClient, parseCsv } from "@so/core/prolific";
import { q, one } from "./db.js";
import { audit } from "./audit.js";
import { ServiceError } from "./studies.js";

async function context(actor, slug) {
  const s = await one("SELECT * FROM studies WHERE slug = $1", [slug]);
  if (!s || !(actor.user.tier === "lab_head" || s.owner_id === actor.user.id)) throw new ServiceError(`No study "${slug}" that you can see.`, 404);
  if (actor.user.tier === "supervised") throw new ServiceError("Supervised accounts can't operate Prolific.", 403);
  const dep = await one("SELECT * FROM deployments WHERE study_id = $1 ORDER BY started_at DESC LIMIT 1", [s.id]);
  if (!dep?.prolific_study_id) throw new ServiceError("No Prolific study id recorded for this study's data collection.");
  const client = prolificClient(process.env.PROLIFIC_TOKEN);
  if (!client) throw new ServiceError("Prolific isn't connected (no PROLIFIC_TOKEN secret). See SETUP.md.");
  return { s, dep, client };
}

export async function prolificStatus(actor, slug) {
  const { dep, client } = await context(actor, slug);
  const st = await client.getStudy(dep.prolific_study_id);
  return {
    prolific_status: st.status,
    total_available_places: st.total_available_places,
    places_taken: st.places_taken ?? null,
    envelope_max_n: dep.max_n,
    our_deployment: { phase: dep.phase, status: dep.status },
  };
}

/** Adds places, never beyond the approved max N. */
export async function addPlaces(actor, slug, add) {
  if (!Number.isInteger(add) || add < 1 || add > 500) throw new ServiceError("add must be a whole number from 1 to 500.");
  const { s, dep, client } = await context(actor, slug);
  if (dep.status !== "active") throw new ServiceError(`Data collection is ${dep.status}; places can only be added while it's active.`);
  const st = await client.getStudy(dep.prolific_study_id);
  const next = st.total_available_places + add;
  if (next > dep.max_n) {
    throw new ServiceError(`That would make ${next} places, above the approved maximum of ${dep.max_n}. At most ${Math.max(0, dep.max_n - st.total_available_places)} more.`, 403);
  }
  await client.setPlaces(dep.prolific_study_id, next);
  await audit(actor, "prolific_places_added", { studyId: s.id, hash: dep.hash, detail: { from: st.total_available_places, to: next } });
  return { total_available_places: next, envelope_max_n: dep.max_n, note: "Assignment sends new participants to the conditions that are furthest behind." };
}

/**
 * Approves submissions whose session completed on the platform. Everything
 * else (incomplete, not found, anything to reject) is left for a person.
 * Excluded-for-performance participants are still paid.
 */
export async function approveSubmissions(actor, slug) {
  const { s, dep, client } = await context(actor, slug);
  const subs = (await client.submissions(dep.prolific_study_id))?.results ?? [];
  const awaiting = subs.filter((x) => /AWAITING/.test(x.status ?? ""));
  const ours = (
    await q(
      `SELECT p.prolific_pid, s.status FROM participant_ids p JOIN sessions s ON s.id = p.session_id WHERE p.study_id = $1`,
      [s.id],
    )
  ).rows;
  const complete = new Set(ours.filter((r) => r.status === "complete").map((r) => r.prolific_pid));
  let approved = 0;
  let failed = 0;
  const left = { no_complete_session: 0 };
  for (const sub of awaiting.slice(0, 200)) {
    if (!complete.has(sub.participant_id)) {
      left.no_complete_session++;
      continue;
    }
    try {
      await client.approveSubmission(sub.id);
      approved++;
    } catch {
      failed++;
    }
  }
  await audit(actor, "prolific_approved", { studyId: s.id, hash: dep.hash, detail: { approved, failed, left } });
  return {
    approved,
    failed,
    left_for_a_person: left,
    note: "Rejections and bonuses are never automatic. Review the remaining submissions on Prolific.",
  };
}

/** Demographics joined to session ids; Prolific IDs and submission ids removed. */
export async function demographics(actor, slug) {
  const { s, dep, client } = await context(actor, slug);
  const csv = await client.demographics(dep.prolific_study_id);
  const rows = parseCsv(csv);
  const map = new Map(
    (await q("SELECT prolific_pid, session_id FROM participant_ids WHERE study_id = $1", [s.id])).rows.map((r) => [r.prolific_pid, r.session_id]),
  );
  const drop = /participant id|submission id|^id$|custom study tncs|completion code/i;
  const out = [];
  for (const r of rows) {
    const pid = r["Participant id"] ?? r["participant_id"] ?? r["Participant Id"];
    const sessionId = map.get(pid);
    if (!sessionId) continue;
    const clean = { session_id: sessionId };
    for (const [k, v] of Object.entries(r)) if (!drop.test(k)) clean[k] = v;
    out.push(clean);
  }
  await audit(actor, "prolific_demographics", { studyId: s.id, hash: dep.hash, detail: { rows: out.length } });
  return { rows: out.length, demographics: out };
}

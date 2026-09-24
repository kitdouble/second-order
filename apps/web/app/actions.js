"use server";
// Form actions for the web UI. Each one calls the same service layer the MCP
// tools use, then redirects back with a message.
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { requireActor, bootstrapLabHead, consumeLoginLink, recoverLabHead, COOKIE } from "@/lib/auth";
import { baseUrlFrom } from "@/lib/url";
import * as S from "@/lib/studies";
import * as People from "@/lib/people";
import { getClient, issueCode, validRedirect } from "@/lib/oauth";

const to = (path, kind, text) => {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}${kind}=${encodeURIComponent(String(text).slice(0, 1500))}`;
};

async function run(path, fn) {
  let target;
  try {
    const out = await fn();
    target = typeof out === "string" ? out : to(path, "msg", out?.message ?? "Done.");
  } catch (e) {
    if (e?.digest?.startsWith?.("NEXT_REDIRECT")) throw e;
    if (!(e instanceof S.ServiceError)) console.error(e);
    target = to(path, "err", e instanceof S.ServiceError ? e.message : "Something went wrong. It has been logged.");
  }
  redirect(target);
}

const base = async () => baseUrlFrom(await headers());
const f = (fd, k) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

// ---- setup & auth

export async function setupAction(fd) {
  const r = await bootstrapLabHead(f(fd, "name"), f(fd, "code"));
  if (!r.ok) redirect(to("/setup", "err", r.error));
  // Sign in directly (a redirect to the link route would lose the cookie).
  const s = await consumeLoginLink(r.link);
  const jar = await cookies();
  jar.set(COOKIE, s.session, { httpOnly: true, sameSite: "lax", path: "/", maxAge: s.maxAge, secure: (await base()).startsWith("https") });
  redirect(to("/", "msg", `Welcome, ${s.user.name}. Next: add people, and connect Claude.`));
}

// ---- specs

export async function saveSpecAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  const back = slug ? `/studies/${slug}?tab=spec` : "/studies/new";
  await run(back, async () => {
    const r = await S.saveSpec(actor, { yaml: fd.get("yaml") ?? "", message: f(fd, "message"), baseHash: f(fd, "base_hash"), expectSlug: slug });
    if (!r.saved) throw new S.ServiceError(r.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
    const where = `/studies/${r.study}?tab=${r.ok ? "overview" : "spec"}`;
    return to(where, r.ok ? "msg" : "err", r.unchanged ? "No changes." : r.ok ? `Saved ${r.short}. Next: run QA.` : `Saved ${r.short} with errors:\n${r.errors.map((e) => `${e.path}: ${e.message}`).join("\n")}`);
  });
}

export async function forkAction(fd) {
  const actor = await requireActor();
  const from = f(fd, "from");
  await run(`/studies/${from}`, async () => {
    const r = await S.forkStudy(actor, from, f(fd, "new_slug"), f(fd, "title"));
    if (!r.saved) throw new S.ServiceError(r.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
    return to(`/studies/${r.study}`, "msg", `Forked. New study ${r.study}.`);
  });
}

// ---- checks

export async function qaAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}?tab=checks`, async () => {
    const r = await S.runQa(actor, slug);
    return { message: r.ok ? `QA passed on ${r.hash} (${r.findings.length} note(s)).` : `QA found blockers on ${r.hash}.` };
  });
}

export async function simAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}?tab=checks`, async () => {
    const reps = Number(f(fd, "reps") ?? 50);
    const r = await S.runSimulation(actor, slug, { reps: Number.isFinite(reps) ? Math.min(500, Math.max(5, reps)) : 50 });
    return { message: `Simulation: ${r.reps_done} of ${r.reps_requested} runs in ${r.seconds}s${r.truncated ? " (time limit reached; ask for fewer reps for a full run)" : ""}.` };
  });
}

export async function previewAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}?tab=checks`, async () => {
    const r = await S.makePreview(actor, slug, await base());
    return `/studies/${slug}?tab=checks&pv=${encodeURIComponent(JSON.stringify(r.links))}`;
  });
}

// ---- review

export async function requestReviewAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}`, async () => S.requestReview(actor, slug, f(fd, "summary")));
}

export async function decideAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}`, async () => {
    const r = await S.decideReview(actor, slug, { decision: f(fd, "decision"), note: f(fd, "note") });
    return { message: r.decision === "approve" ? (r.gate === "pilot" ? "Approved for pilot." : "Go-live approved.") : "Changes requested." };
  });
}

export async function commentAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}?tab=review`, async () => {
    await S.addComment(actor, slug, { body: f(fd, "body"), severity: f(fd, "severity"), path: f(fd, "path") });
    return { message: "Comment added." };
  });
}

export async function resolveAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}?tab=review`, async () => {
    await S.resolveComment(actor, slug, f(fd, "id"), { status: f(fd, "status"), resolution: f(fd, "resolution") });
    return { message: "Finding resolved." };
  });
}

// ---- running

export async function startAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}`, async () => {
    const r = await S.startDeployment(actor, slug, f(fd, "phase"), { prolific_study_id: f(fd, "prolific_study_id"), completion_code: f(fd, "completion_code") }, await base());
    return { message: `${r.phase === "pilot" ? "Pilot" : "Main collection"} started. ${r.instructions}` };
  });
}

export async function runStateAction(fd) {
  const actor = await requireActor();
  const slug = f(fd, "slug");
  await run(`/studies/${slug}`, async () => S.setRunState(actor, slug, f(fd, "action"), f(fd, "note")));
}

// ---- people & settings

export async function addPersonAction(fd) {
  const actor = await requireActor();
  await run("/people", async () => {
    const r = await People.addPerson(actor, { name: f(fd, "name"), tier: f(fd, "tier") });
    return `/people?link=${encodeURIComponent(`${await base()}/login/${r.token}`)}&for=${encodeURIComponent(r.user.name)}`;
  });
}

export async function issueLinkAction(fd) {
  const actor = await requireActor();
  await run("/people", async () => {
    const r = await People.issueLink(actor, f(fd, "id"));
    return `/people?link=${encodeURIComponent(`${await base()}/login/${r.token}`)}&for=${encodeURIComponent(r.user.name)}`;
  });
}

export async function setTierAction(fd) {
  const actor = await requireActor();
  await run("/people", async () => {
    await People.setTier(actor, f(fd, "id"), f(fd, "tier"));
    return { message: "Tier updated." };
  });
}

export async function disableAction(fd) {
  const actor = await requireActor();
  await run("/people", async () => {
    await People.setDisabled(actor, f(fd, "id"), f(fd, "disabled") === "1");
    return { message: "Updated." };
  });
}

export async function meetingAction(fd) {
  const actor = await requireActor();
  const id = f(fd, "id");
  await run(`/people/${id}`, async () => {
    await S.markMeeting(actor, id);
    return { message: "Meeting marked. Next time this page starts from here." };
  });
}

export async function standardsAction(fd) {
  const actor = await requireActor();
  await run("/settings", async () => {
    await S.setLabStandards(actor, fd.get("text") ?? "");
    return { message: "Lab standards saved." };
  });
}

export async function revokeAction(fd) {
  const actor = await requireActor();
  await run("/connect", async () => {
    await People.revokeConnection(actor, f(fd, "client_id"));
    return { message: "Connection revoked." };
  });
}

// ---- OAuth consent

export async function consentAction(fd) {
  const actor = await requireActor();
  const clientId = f(fd, "client_id");
  const redirectUri = f(fd, "redirect_uri");
  const state = fd.get("state") ?? "";
  const client = await getClient(clientId);
  if (!client || !client.redirect_uris.includes(redirectUri) || !validRedirect(redirectUri)) redirect("/connect?err=Unknown%20client");
  const u = new URL(redirectUri);
  if (f(fd, "decision") !== "allow") {
    u.searchParams.set("error", "access_denied");
    if (state) u.searchParams.set("state", state);
    redirect(u.toString());
  }
  const code = await issueCode({ clientId, userId: actor.user.id, redirectUri, codeChallenge: f(fd, "code_challenge") });
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  redirect(u.toString());
}

export async function signOutAction() {
  const jar = await cookies();
  jar.delete(COOKIE);
  redirect("/");
}

// ---- library

export async function tryTaskAction(fd) {
  const actor = await requireActor();
  await run("/library", async () => {
    const L = await import("@/lib/library");
    const r = await L.tryLink(actor, f(fd, "target"), await base());
    return r.link;
  });
}

export async function retireTaskAction(fd) {
  const actor = await requireActor();
  await run("/library", async () => {
    const L = await import("@/lib/library");
    const r = await L.retireFromLibrary(actor, f(fd, "name"));
    return { message: `Retired ${r.retired.join(", ")}. ${r.note}` };
  });
}

// ---- passkeys & recovery

export async function removePasskeyAction(fd) {
  const actor = await requireActor();
  await run("/settings", async () => {
    const P = await import("@/lib/passkeys");
    await P.removePasskey(actor.user, f(fd, "id"));
    return { message: "Passkey removed." };
  });
}

export async function recoverAction(fd) {
  const r = await recoverLabHead(f(fd, "code"));
  if (!r.ok) redirect(to("/setup", "err", r.error));
  const jar = await cookies();
  jar.set(COOKIE, r.session.session, { httpOnly: true, sameSite: "lax", path: "/", maxAge: r.session.maxAge, secure: (await base()).startsWith("https") });
  redirect(to("/settings", "msg", `Signed in as ${r.session.user.name}. Add a passkey so this doesn't happen again.`));
}

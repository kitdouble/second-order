// The lab library: steps (a block plus its params) the lab head has added so
// anyone in the lab can reuse them. Built-in blocks are listed alongside.
// Library custom code counts as vetted: the lab head read it when adding it.
import {
  blockCatalog,
  getBlock,
  stepId,
  builtinDemoParams,
  demoSpec,
  hashSpec,
  shortHash,
  listConditions,
  librarySnippet,
  matchesLibrary,
  libraryClaims,
  LIBRARY_NAME,
  LIBRARY_REF,
} from "@so/core";
import { q, one, j } from "./db.js";
import { audit } from "./audit.js";
import { newToken, sha256 } from "./tokens.js";
import { ServiceError, isLabHead, loadStudy, versionOf } from "./studies.js";

const fail = (m, status) => {
  throw new ServiceError(m, status);
};
const SYSTEM_SLUG = "_library"; // hidden study that holds "try it" specs

// ---------------------------------------------------------------- reading

async function activeEntries() {
  return (
    await q(
      `SELECT DISTINCT ON (e.name) e.*, u.name AS added_by_name
       FROM library_entries e LEFT JOIN users u ON u.id = e.added_by
       WHERE e.retired_at IS NULL ORDER BY e.name, e.version DESC`,
    )
  ).rows;
}

/** How many studies (excluding the demo study) use each library name. */
async function usage() {
  const r = await q(
    `SELECT it->>'library' AS ref, count(DISTINCT s.id) AS n
     FROM studies s JOIN spec_versions v ON v.hash = s.current_hash,
          jsonb_array_elements(v.spec->'sequence') it
     WHERE s.slug <> '${SYSTEM_SLUG}' AND it ? 'library'
     GROUP BY 1`,
  );
  const out = {};
  for (const row of r.rows) {
    const name = row.ref.split("@")[0];
    out[name] = (out[name] ?? 0) + Number(row.n);
  }
  return out;
}

function summarise(e, uses) {
  const block = getBlock(e.block_ref);
  return {
    name: e.name,
    ref: `${e.name}@${e.version}`,
    title: e.title,
    description: e.description,
    block: e.block_ref,
    verified: !block?.custom,
    columns: block?.custom ? e.params.columns : block?.columns,
    added_by: e.added_by_name,
    from: e.source_study ? `${e.source_study} step ${e.source_step}` : null,
    added: e.created_at,
    used_by_studies: uses[e.name] ?? 0,
    ...(block?.custom && (uses[e.name] ?? 0) >= 3
      ? { suggestion: "Used by 3+ studies: worth turning into a verified block (see CLAUDE.md in the repo)." }
      : {}),
  };
}

/** Everything a student can pick from: built-in blocks and lab library entries. */
export async function listLibrary() {
  const [entries, uses] = await Promise.all([activeEntries(), usage()]);
  return {
    builtin: blockCatalog().map((b) => ({
      ref: b.ref,
      title: b.title,
      description: b.description,
      verified: !b.unverified,
      columns: b.columns,
      can_try: builtinDemoParams(b.ref) !== null,
    })),
    lab: entries.map((e) => summarise(e, uses)),
  };
}

async function entryAt(name, version = null) {
  const e = version
    ? await one("SELECT e.*, u.name AS added_by_name FROM library_entries e LEFT JOIN users u ON u.id = e.added_by WHERE e.name = $1 AND e.version = $2", [name, version])
    : await one(
        "SELECT e.*, u.name AS added_by_name FROM library_entries e LEFT JOIN users u ON u.id = e.added_by WHERE e.name = $1 AND e.retired_at IS NULL ORDER BY e.version DESC LIMIT 1",
        [name],
      );
  if (!e) fail(`No lab library task "${name}${version ? `@${version}` : ""}".`, 404);
  return e;
}

function parseRef(ref) {
  const m = LIBRARY_REF.exec(ref ?? "");
  if (m) return { name: m[1], version: Number(m[2]) };
  if (LIBRARY_NAME.test(ref ?? "")) return { name: ref, version: null };
  fail(`"${ref}" isn't a library name (e.g. "go-nogo" or "go-nogo@2").`);
}

/** One library entry in full, with the YAML to paste into a study. */
export async function getLibraryEntry(ref) {
  const { name, version } = parseRef(ref);
  const e = await entryAt(name, version);
  const uses = await usage();
  return {
    ...summarise(e, uses),
    retired: Boolean(e.retired_at),
    params: e.params,
    snippet: librarySnippet(e),
    how_to_use:
      "Paste the block alias into blocks and the step into sequence. Keep library and params unchanged: then the step counts as vetted, " +
      "so it's recorded as coming from a reviewed source. Changing params makes it new custom code (approval still just follows the usual " +
      "tier spend rules, same as any study). Measures can use the columns listed.",
  };
}

// ---------------------------------------------------------------- vetting

/** True if every custom-code step in the spec is an unchanged, current library entry. */
export async function customCodeVetted(spec) {
  const custom = spec.sequence.filter((it) => getBlock(spec.blocks[it.use])?.custom);
  if (!custom.length) return true;
  for (const it of custom) {
    const m = LIBRARY_REF.exec(it.library ?? "");
    if (!m) return false;
    const e = await one("SELECT * FROM library_entries WHERE name = $1 AND version = $2 AND retired_at IS NULL", [m[1], Number(m[2])]);
    if (!e || !matchesLibrary(spec, it, e)) return false;
  }
  return true;
}

/** Adjusts validation warnings for steps that claim to come from the library. */
export async function libraryWarnings(spec, warnings) {
  const claims = libraryClaims(spec);
  if (!claims.length) return warnings;
  let out = [...warnings];
  for (const c of claims) {
    const path = `sequence.${c.index}`;
    const e = await one("SELECT * FROM library_entries WHERE name = $1 AND version = $2", [c.name, c.version]);
    if (!e) {
      out.push({ path: `${path}.library`, message: `Step "${c.id}" says it's from the lab library as ${c.item.library}, but there's no such entry.` });
      continue;
    }
    if (e.retired_at) out.push({ path: `${path}.library`, message: `Lab library task ${c.item.library} has been retired. Check the library for a replacement.` });
    if (!matchesLibrary(spec, c.item, e)) {
      out.push({
        path: `${path}.library`,
        message: `Step "${c.id}" differs from lab library task ${c.item.library}, so it counts as new${getBlock(e.block_ref)?.custom ? " custom code and can't be simulated, so pilot it" : " settings"}.`,
      });
    } else if (getBlock(e.block_ref)?.custom && !e.retired_at) {
      out = out.filter((w) => !(w.path === path && /runs custom code/.test(w.message)));
      out.push({
        path,
        message: `Step "${c.id}" is lab library task ${c.item.library}: custom code the lab head vetted. It can't be simulated, so pilot it; approval follows the usual tier rules.`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- changing

/** Adds a step from a study to the library (lab head only). Same name again = new version. */
export async function addToLibrary(actor, { study, step, name, title = null, description = null, hash = null }) {
  if (!isLabHead(actor)) fail("Only the lab head adds tasks to the lab library.", 403);
  if (!LIBRARY_NAME.test(name ?? "")) fail('Name: lowercase letters, digits and hyphens, e.g. "go-nogo".');
  const s = await loadStudy(actor, study);
  const v = await versionOf(s, hash);
  if (!v.validation.ok) fail("That version has validation errors. Fix them first.");
  const item = v.spec.sequence.find((it) => stepId(it) === step);
  if (!item) fail(`No step "${step}" in ${study}. Steps: ${v.spec.sequence.map(stepId).join(", ")}.`);
  const ref = v.spec.blocks[item.use];
  const block = getBlock(ref);
  if (JSON.stringify(item.params ?? {}).includes('"$cond"')) {
    fail(`Step "${step}" has per-condition params ($cond). Library tasks need fixed params; copy the version you want into a study without $cond first.`);
  }
  const prev = await one("SELECT max(version) AS v FROM library_entries WHERE name = $1", [name]);
  const version = (prev?.v ?? 0) + 1;
  const desc = description ?? item.params?.description ?? block?.description;
  await q(
    `INSERT INTO library_entries (name, version, title, description, block_ref, params, source_study, source_hash, source_step, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [name, version, title ?? v.spec.study.title, desc, ref, j(item.params ?? {}), s.slug, v.hash, step, actor.user.id],
  );
  await audit(actor, "library_added", { studyId: s.id, hash: v.hash, detail: { name, version, step } });
  return {
    added: `${name}@${version}`,
    verified: !block?.custom,
    note: block?.custom
      ? "Custom code: by adding it you've vetted it, so studies using it unchanged follow the usual tier rules."
      : "A preset of a verified block.",
    ...(version > 1 ? { previous_versions: "Studies using earlier versions keep them; new studies get this one." } : {}),
  };
}

export async function retireFromLibrary(actor, ref) {
  if (!isLabHead(actor)) fail("Only the lab head retires library tasks.", 403);
  const { name, version } = parseRef(ref);
  const r = await q(
    `UPDATE library_entries SET retired_at = now() WHERE name = $1 AND retired_at IS NULL ${version ? "AND version = $2" : ""} RETURNING version`,
    version ? [name, version] : [name],
  );
  if (!r.rowCount) fail(`Nothing to retire for "${ref}".`, 404);
  await audit(actor, "library_retired", { detail: { name, versions: r.rows.map((x) => x.version) } });
  return { retired: r.rows.map((x) => `${name}@${x.version}`), note: "Existing studies keep working. New studies can't use it as vetted code." };
}

// ---------------------------------------------------------------- try it

async function systemStudy() {
  const found = await one("SELECT * FROM studies WHERE slug = $1", [SYSTEM_SLUG]);
  if (found) return found;
  const head = await one("SELECT id FROM users WHERE tier = 'lab_head' ORDER BY created_at LIMIT 1");
  if (!head) fail("Set up the lab head first.");
  await q("INSERT INTO studies (slug, title, owner_id) VALUES ($1, 'Lab library demos', $2) ON CONFLICT (slug) DO NOTHING", [SYSTEM_SLUG, head.id]);
  return one("SELECT * FROM studies WHERE slug = $1", [SYSTEM_SLUG]);
}

/** A preview link that runs one built-in block or library task on its own. */
export async function tryLink(actor, target, baseUrl) {
  let demo;
  if (getBlock(target)) {
    const params = builtinDemoParams(target);
    if (!params) fail(`No demo for ${target}.`);
    demo = demoSpec({ title: getBlock(target).title, ref: target, params });
  } else {
    const { name, version } = parseRef(target);
    const e = await entryAt(name, version);
    demo = demoSpec({ title: e.title, ref: e.block_ref, params: e.params, library: `${e.name}@${e.version}` });
  }
  if (!demo.ok) fail(`This task doesn't validate on its own: ${demo.errors.map((x) => `${x.path}: ${x.message}`).join("; ")}`);
  const s = await systemStudy();
  const hash = await hashSpec(demo.spec);
  await q(
    `INSERT INTO spec_versions (hash, study_id, yaml, spec, created_by, created_via, validation, message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'library demo') ON CONFLICT (hash) DO NOTHING`,
    [hash, s.id, demo.yaml, j(demo.spec), actor.user.id, actor.client, j({ ok: true, errors: [], warnings: [] })],
  );
  const token = newToken(16);
  await q("INSERT INTO preview_tokens (token_hash, hash, created_by, expires_at) VALUES ($1,$2,$3, now() + interval '3 days')", [
    sha256(token),
    hash,
    actor.user.id,
  ]);
  const cond = listConditions(demo.spec)[0].key;
  return { link: `${baseUrl}/s/${hash.slice(0, 16)}/?preview=${token}&cond=${encodeURIComponent(cond)}`, hash: shortHash(hash), expires_in_days: 3 };
}

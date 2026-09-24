// Semantic diff between two spec versions: plain-language changes, each
// classed as major (design, measures, N, pay, analysis) or minor (wording).
import { stepId } from "./compile.js";

const TEXT_KEYS = new Set(["text", "pages", "item", "preamble", "title", "labels", "agree_label", "decline_label", "hypothesis", "approved_protocol", "secondary", "note", "why", "if_fails"]);

function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    // Arrays of scalars compare as a whole; arrays of objects by index.
    if (value.every((v) => v === null || typeof v !== "object")) out[prefix] = JSON.stringify(value);
    else value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = value;
  return out;
}

function normalise(spec) {
  const s = structuredClone(spec);
  // Key steps by id so reordering and inserts read sensibly.
  s.sequence = Object.fromEntries(spec.sequence.map((it, i) => [stepId(it), { ...it, position: i + 1 }]));
  s.exclusions = Object.fromEntries((spec.exclusions ?? []).map((e) => [e.id, e.when]));
  if (spec.pilot?.checks) s.pilot = { ...spec.pilot, checks: Object.fromEntries(spec.pilot.checks.map((c) => [c.id, `${c.expect} [${c.level}]`])) };
  return s;
}

function classify(path) {
  const last = path.split(".").at(-1).replace(/\[\d+\]$/, "");
  const parts = path.split(".");
  if (parts.some((p) => TEXT_KEYS.has(p.replace(/\[\d+\]$/, "")))) return "minor";
  if (last === "position") return "major";
  if (path.startsWith("study.")) return "minor";
  return "major";
}

function describe(path) {
  return path
    .replace(/^sequence\.(\w+)\.params\./, "step $1 › ")
    .replace(/^sequence\.(\w+)\./, "step $1 › ")
    .replace(/\.\$cond/, " (condition factor)")
    .replace(/\./g, " › ");
}

const show = (v) => (v === undefined ? "(none)" : typeof v === "string" && v.length > 80 ? `"${v.slice(0, 77)}..."` : JSON.stringify(v));

export function diffSpecs(a, b) {
  const fa = flatten(normalise(a), "", {});
  const fb = flatten(normalise(b), "", {});
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
  const changes = [];
  for (const k of keys) {
    if (fa[k] === fb[k]) continue;
    const kind = classify(k);
    const verb = fa[k] === undefined ? "added" : fb[k] === undefined ? "removed" : "changed";
    changes.push({
      path: k,
      kind,
      from: fa[k],
      to: fb[k],
      sentence:
        verb === "added"
          ? `${describe(k)}: added ${show(fb[k])}`
          : verb === "removed"
            ? `${describe(k)}: removed (was ${show(fa[k])})`
            : `${describe(k)}: ${show(fa[k])} → ${show(fb[k])}`,
    });
  }
  return {
    major: changes.filter((c) => c.kind === "major"),
    minor: changes.filter((c) => c.kind === "minor"),
    summary: changes.length
      ? `${changes.filter((c) => c.kind === "major").length} major, ${changes.filter((c) => c.kind === "minor").length} wording change(s).`
      : "No changes.",
  };
}

/** Is this a deviation from a preregistered/approved spec? (Any major change.) */
export function isDeviation(diff) {
  return diff.major.length > 0;
}

// Consent and debrief texts fixed into this version when it was saved (see server/documents.js).
import documents from "second-order:documents";
import logoUrl from "./blocks/assets/usyd-logo.png";

const EXAMPLE_DOCUMENT = "example-protocol";

const keys = () => Object.keys(documents).filter((key) => !key.startsWith("_"));

/**
 * The document used when none is named: the lab's oldest protocol (the placeholder template only if it has none).
 * Undefined for an outside colleague's study (`_default` is null in their documents): they name their own.
 */
export function defaultDocument() {
  if ("_default" in documents) return documents._default ?? undefined;
  return keys().find((key) => key !== EXAMPLE_DOCUMENT) ?? EXAMPLE_DOCUMENT;
}

// A short fingerprint of inline text, so the data shows which wording each participant saw.
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Consent or debrief text written in the study itself: { html, ethics }. `ethics` is the approval reference
 * (e.g. "HREC 2026/123"), required, and is recorded with a fingerprint of the text as the form label.
 */
export function inlineDocument(kind, html, ethics, document) {
  if (document) throw new Error(`${kind}(): give either \`document\` (from the library) or \`html\` and \`ethics\` (written here), not both.`);
  if (typeof html !== "string" || html.trim().length < 20) throw new Error(`${kind}({ html }): html must be the full ${kind} text as HTML.`);
  if (typeof ethics !== "string" || ethics.trim().length < 3) {
    throw new Error(`${kind}({ html }) also needs ethics: the approval reference this wording was approved under, e.g. ethics: "HREC 2026/123".`);
  }
  return { title: `${kind} (inline)`, form_label: `${ethics.trim()} (inline ${kind} ${fingerprint(html)})`, html };
}

/** The text for this kind and recruitment (or the document's "any" text), or undefined. */
export function findDocument(key = defaultDocument(), kind, recruitment) {
  if (key === undefined) throw new Error(noDefault(kind));
  const texts = documents[key]?.[kind];
  return texts?.[recruitment] ?? texts?.any;
}

const noDefault = (kind) =>
  `This account has no default protocol, so ${kind}() needs to know which ethics wording to show. Either name a protocol you saved ` +
  `(save_document, then ${kind}({ document: "hrec-2026-123" })) or write the text in the study: ${kind}({ html, ethics: "<your approval reference>" }).`;

export function documentFor(key = defaultDocument(), kind, recruitment) {
  if (key === undefined) throw new Error(noDefault(kind));
  if (!documents[key]) {
    throw new Error(`There's no document "${key}". Available: ${keys().join(", ") || "none"} (list_documents).`);
  }
  const doc = findDocument(key, kind, recruitment);
  if (!doc) {
    throw new Error(
      recruitment === "lab" || recruitment === "none"
        ? `"${key}" has no approved ${kind} for in-lab studies yet. Ask the researcher for their ethics-approved wording.`
        : `"${key}" has no ${kind} for ${recruitment} participants.`,
    );
  }
  return doc;
}

/** Fill {{minutes}}, {{payment}}, {{credit}} and {{logo}}. */
export function fill(html, values) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, name) => (name === "logo" ? logoUrl : name in values ? String(values[name]) : match));
}

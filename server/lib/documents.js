// Consent and debrief texts fixed into this version when it was saved (see server/documents.js).
import documents from "second-order:documents";
import logoUrl from "./blocks/assets/usyd-logo.png";

/** The text for this kind and recruitment (or the document's "any" text), or undefined. */
export function findDocument(key, kind, recruitment) {
  const texts = documents[key]?.[kind];
  return texts?.[recruitment] ?? texts?.any;
}

export function documentFor(key, kind, recruitment) {
  if (!documents[key]) {
    throw new Error(`There's no document "${key}". Available: ${Object.keys(documents).join(", ") || "none"} (list_documents).`);
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

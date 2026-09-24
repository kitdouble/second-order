// Minimal, safe text formatting for participant-facing copy.
// Supports paragraphs (blank lines) and **bold**. Everything is HTML-escaped.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function textToHtml(text) {
  return String(text ?? "")
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${escapeHtml(p.trim()).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Plain text version, for AI review and word counts. */
export function textToPlain(text) {
  return String(text ?? "").replace(/\*\*(.+?)\*\*/g, "$1").trim();
}

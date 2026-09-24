// Thin Prolific API client (https://docs.prolific.com). Server-side only.
// The platform never creates or publishes Prolific studies; a human does that.
// These calls are the envelope-limited operations the agent is allowed.

const BASE = "https://api.prolific.com/api/v1";

export class ProlificError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function prolificClient(token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token) return null;
  async function call(method, path, body, { raw = false } = {}) {
    const res = await fetchImpl(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Token ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ProlificError(`Prolific ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`, res.status);
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  }
  return {
    getStudy: (id) => call("GET", `/studies/${encodeURIComponent(id)}/`),
    pause: (id) => call("POST", `/studies/${encodeURIComponent(id)}/transition/`, { action: "PAUSE" }),
    start: (id) => call("POST", `/studies/${encodeURIComponent(id)}/transition/`, { action: "START" }),
    /** Places can only go up once published (Prolific rule). */
    setPlaces: (id, total) => call("PATCH", `/studies/${encodeURIComponent(id)}/`, { total_available_places: total }),
    submissions: (id) => call("GET", `/studies/${encodeURIComponent(id)}/submissions/`),
    approveSubmission: (submissionId) => call("POST", `/submissions/${encodeURIComponent(submissionId)}/transition/`, { action: "APPROVE" }),
    demographics: (id) => call("POST", `/studies/${encodeURIComponent(id)}/demographic-export/`, {}, { raw: true }),
  };
}

/** Minimal CSV parser for Prolific exports (quoted fields, commas, newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  return (body ?? []).map((r) => Object.fromEntries((header ?? []).map((h, i) => [h, r[i] ?? ""])));
}

// Experience sampling (ESM) studies. The experiment module may export `esm` to describe its schedule:
//
//   export const esm = {
//     notification: { title: "Quick check-in", body: "Takes about 2 minutes" }, // default for every session
//     expires_minutes: 30,                                                      // default: how long a session stays open
//     sessions: 14,  // a count, or a list: [{ name: "Day 1 morning", time: "Day 1, 09:00", notification: { … }, expires_minutes: 45 }]
//   };
//
// buildTimeline then reads `context.session` (1-based) to decide which session's timeline to return.
// This only reads the description for the dashboard; scheduling and sending notifications is not done here.

const MAX_SESSIONS = 1000;
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const minutes = (v) => (Number.isFinite(v) && v > 0 ? v : null);

function notificationOf(value, fallback) {
  const title = text(value?.title) ?? fallback?.title ?? null;
  const body = text(value?.body) ?? fallback?.body ?? null;
  return title || body ? { title, body } : null;
}

/** The session list and notifications from an experiment's `esm` export, or null when it has none. */
export function describeEsm(esm) {
  if (esm == null || typeof esm !== 'object') return null;
  const notification = notificationOf(esm.notification, null);
  const expires = minutes(esm.expires_minutes);
  const given = Array.isArray(esm.sessions)
    ? esm.sessions.slice(0, MAX_SESSIONS)
    : Array.from({ length: Math.min(Math.max(Math.floor(Number(esm.sessions)) || 0, 0), MAX_SESSIONS) }, () => ({}));
  const sessions = given.map((s, i) => ({
    number: i + 1,
    name: text(s?.name) ?? `Session ${i + 1}`,
    time: text(s?.time),
    notification: notificationOf(s?.notification, notification),
    expires_minutes: minutes(s?.expires_minutes) ?? expires,
  }));
  return { notification, expires_minutes: expires, sessions };
}

/** A session number from a query value: a whole number within the list, else 1. */
export function sessionNumber(value, esm) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= Math.max(esm?.sessions.length ?? 1, 1) ? n : 1;
}

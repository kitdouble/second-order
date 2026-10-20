// Run details the blocks need, set by the runtime (or the simulator) before buildTimeline runs.
export const context = {
  mode: "preview",
  recruitment: "prolific",
  version: 0,
  session: 1, // experience sampling: which session (1-based) this run is
  jsPsych: null,
  // Replaced by the runtime (server-balanced), the simulator (rotates) and the dashboard (random).
  assign: async (_name, conditions) => conditions[Math.floor(Math.random() * conditions.length)],
  // Replaced by the runtime, which asks the server for a real code; the simulator and dashboard show this one.
  esmCode: async (_study) => "SO-TEST-CODE",
};

export const setContext = (values) => Object.assign(context, values);

/** Where this participant came from: "prolific", "sona", "lab" or "none". */
export const recruitment = () => context.recruitment;

// Lab rates.
export const SONA_CREDIT_PER_HOUR = 1;
export const PROLIFIC_GBP_PER_HOUR = 6;

/**
 * What participants get for the study's length: { minutes, credit } for SONA, rounded up to the next
 * 0.25 credit, or { minutes, payment } for Prolific, rounded up to the penny and written like "£1" or
 * "£1.50". Null when minutes isn't set, or for other recruitment.
 */
export function compensation(minutesGiven) {
  const minutes = Number(minutesGiven);
  if (!(minutes > 0)) return null;
  const name = recruitment();
  if (name === "sona") {
    const credit = Math.ceil(((minutes / 60) * SONA_CREDIT_PER_HOUR) / 0.25 - 1e-9) * 0.25;
    return { minutes, credit };
  }
  if (name === "prolific") {
    const pence = Math.ceil((minutes / 60) * PROLIFIC_GBP_PER_HOUR * 100 - 1e-9);
    const payment = pence % 100 === 0 ? `£${pence / 100}` : `£${(pence / 100).toFixed(2)}`;
    return { minutes, payment };
  }
  return null;
}

/**
 * Balanced condition assignment, done by the server: each new participant gets the condition with the
 * fewest participants so far on their link (completed, plus those active in the last 30 minutes). The
 * choice is saved, so a participant who reloads gets the same one, and it's added to every data row as
 * `name` (default "condition"). Call it in buildTimeline, which must then be async:
 *
 *   export default async function buildTimeline(jsPsych) {
 *     const condition = await assignCondition(["speed", "accuracy"]);
 */
export async function assignCondition(conditions, { name = "condition" } = {}) {
  if (!Array.isArray(conditions) || conditions.length < 2) throw new Error("assignCondition needs a list of at least two conditions.");
  const labels = conditions.map(String);
  if (new Set(labels).size !== labels.length) throw new Error("assignCondition: conditions must be different from each other.");
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(name)) throw new Error("assignCondition: name must be a simple column name, e.g. \"condition\".");
  const value = await context.assign(name, labels);
  const chosen = conditions[labels.indexOf(value)];
  if (chosen === undefined) throw new Error(`assignCondition: the server returned "${value}", which isn't one of the conditions.`);
  context.jsPsych?.data.addProperties({ [name]: chosen });
  return chosen;
}

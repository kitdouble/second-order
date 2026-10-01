// Run details the blocks need, set by the runtime (or the simulator) before buildTimeline runs.
export const context = { mode: "preview", recruitment: "prolific", version: 0 };

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

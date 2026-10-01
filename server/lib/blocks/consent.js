import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { documentFor, fill } from "../documents.js";
import { compensation, recruitment } from "../context.js";
import "./consent.css";

// Participant Information Statement and consent, from the document library (default: HREC 2022/796).
// The wording is ethics-approved and lives in the library, not here: only the study length and the
// credit or payment are filled in, from `minutes`.

/**
 * The consent form for this link's participants (Prolific, SONA or lab), filled in with the study length
 * and the credit or payment it works out to. `document` picks another protocol's approved text.
 */
export function consent({ minutes, document = "hrec-2022-796" } = {}) {
  const doc = documentFor(document, "consent", recruitment());
  const needsPay = /\{\{(payment|credit)\}\}/.test(doc.html);
  const pay = compensation(minutes);
  if (!(Number(minutes) > 0) || (needsPay && !pay)) {
    throw new Error("consent({ minutes }) needs how long the study takes, in minutes, so the form can show the length and credit or payment.");
  }
  return {
    name: "Consent",
    type: htmlButtonResponse,
    stimulus: fill(doc.html, { minutes: Number(minutes), ...pay }),
    choices: ["Next"],
    data: { consent_form: doc.form_label },
    // Record which form was shown (consent_form), not its full HTML.
    save_trial_parameters: { stimulus: false },
  };
}

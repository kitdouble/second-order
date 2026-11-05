import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { documentFor, fill, inlineDocument } from "../documents.js";
import { compensation, recruitment } from "../context.js";
import "./consent.css";

// Participant Information Statement and consent, from the document library (default: the lab's oldest protocol).
// The wording is ethics-approved and lives in the library, not here: only the study length and the
// credit or payment are filled in, from `minutes`.

/**
 * The consent form for this link's participants (Prolific, SONA or lab), filled in with the study length
 * and the credit or payment it works out to. `document` picks a protocol's text from the library; without it a lab
 * member's studies use the lab's default protocol. Or write the text in the study with `html` (the full Participant
 * Information Statement) and `ethics` (the approval reference), which is recorded in the data as consent_form.
 */
export function consent({ minutes, document, html, ethics } = {}) {
  const doc = html !== undefined || ethics !== undefined
    ? inlineDocument("consent", html, ethics, document)
    : documentFor(document, "consent", recruitment());
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

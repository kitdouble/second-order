import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { findDocument, fill } from "../documents.js";
import { recruitment } from "../context.js";
// Same layout as the Participant Information Statement.
import "./consent.css";

// Debrief statement from the document library (default: HREC 2022/796, which has one for SONA only).

/**
 * The debrief for this link's participants, if the document has one for their recruitment (for HREC
 * 2022/796: SONA only), and skipped otherwise. Put it last in the timeline, after the task.
 */
export function debrief({ document = "hrec-2022-796" } = {}) {
  // Recruitment is known when the timeline is built, so the text can be picked now.
  const doc = findDocument(document, "debrief", recruitment());
  return {
    name: "Debrief",
    conditional_function: () => Boolean(doc),
    timeline: [
      {
        name: recruitment() === "sona" ? "SONA debrief" : "Debrief",
        type: htmlButtonResponse,
        stimulus: doc ? fill(doc.html, {}) : "",
        choices: ["Next"],
        data: { debrief_form: doc?.form_label },
        // Record which statement was shown (debrief_form), not its full HTML.
        save_trial_parameters: { stimulus: false },
      },
    ],
  };
}

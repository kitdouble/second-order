import callFunction from "@jspsych/plugin-call-function";
import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { context } from "../context.js";

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * Gives the participant a single-use enrolment code for an ESM study (`study`, its id), with
 * instructions to install the app and enter it. Put it in an intake study, e.g. after consent and a
 * baseline survey. The server issues the code for this run, so a reload shows the same code, and
 * records which participant (e.g. Prolific PID) it went to: esm_status links the two studies.
 * Saves `esm_code`. In previews the code is a test code; simulations and the dashboard show
 * SO-TEST-CODE. `instructions` replaces the default text (HTML; `{code}` is replaced by the code).
 */
export function esmCode({ study, instructions, button_label = "Continue" } = {}) {
  if (!study) throw new Error('esmCode needs the ESM study\'s id: esmCode({ study: "my-diary-ab12cd" }).');
  let code = null;
  let failure = null;
  return {
    name: "ESM enrolment",
    timeline: [
      {
        name: "Get ESM code",
        type: callFunction,
        async: true,
        func: (done) => {
          context.esmCode(study).then(
            (c) => { code = c; done({ esm_code: c, esm_study: study }); },
            (err) => { failure = err?.message ?? String(err); done({ esm_code: null, esm_study: study, esm_error: failure }); },
          );
        },
      },
      {
        name: "ESM code",
        type: htmlButtonResponse,
        stimulus: () => (code ? codePage(code, instructions) : failurePage()),
        choices: [button_label],
        on_finish: (data) => {
          data.esm_code = code;
          data.esm_study = study;
        },
      },
    ],
  };
}

const codeBox = (code) =>
  `<p style="font:600 32px/1.3 ui-monospace,Menlo,monospace;letter-spacing:2px;margin:24px 0;user-select:all">${escape(code)}</p>`;

function codePage(code, instructions) {
  if (instructions) return String(instructions).replaceAll("{code}", codeBox(code));
  return `<div style="max-width:560px;margin:0 auto;text-align:left">
    <p>The next part of this study happens on your phone, over the coming days.</p>
    <ol>
      <li>Install the free app: <strong>MetaForge Live</strong> from the App Store (iPhone) or <strong>MetaForge EMA</strong> from Google Play (Android).</li>
      <li>Open it, agree to the terms, and enter this code:</li>
    </ol>
    <div style="text-align:center">${codeBox(code)}</div>
    <p>Please write the code down or take a screenshot before you continue. It can be used once, on one phone.</p>
    <p>Allow notifications when the app asks: each one opens a short survey.</p>
  </div>`;
}

const failurePage = () =>
  "<p>Sorry, your code for the phone part of this study couldn't be created.</p><p>Please contact the researcher so they can send you one.</p>";

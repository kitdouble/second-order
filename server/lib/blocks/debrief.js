import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { recruitment } from "../context.js";
import logoUrl from "./assets/usyd-logo.png";
// Same layout as the Participant Information Statement.
import "./consent.css";

// Debrief statement approved under HREC 2022/796 (Version 2, 3 November
// 2022). The wording is ethics-approved: don't edit it. Any change needs an
// ethics amendment and a new version here.

/**
 * The debrief statement, shown only to SONA participants and skipped for
 * everyone else. Put it last in
 * the timeline, after the task.
 */
export function debrief() {
  return {
    name: "Debrief",
    conditional_function: () => recruitment() === "sona",
    timeline: [
      {
        name: "SONA debrief",
        type: htmlButtonResponse,
        stimulus: sonaDebrief(),
        choices: ["Next"],
        data: { debrief_form: "2022/796 SONA debrief v2 (3 November 2022)" },
        // Record which statement was shown (debrief_form), not its full HTML.
        save_trial_parameters: { stimulus: false },
      },
    ],
  };
}

function sonaDebrief() {
  return `
<div class="pis-container">
  <div class="pis-header">
    <div>
      <h1>DEBRIEF</h1>
      <h1 class="pis-title-study">Research Study: Metacognition and Cognitive Performance</h1>
      <div class="pis-contact">
        <div>Dr Kit Double (Responsible Researcher)</div>
        <div>School of Psychology, Faculty of Science</div>
        <div>Phone: +61 2 8627 8636 | Email: kit.double@sydney.edu.au</div>
      </div>
    </div>
    <img alt="University of Sydney" src="${logoUrl}" class="pis-logo">
  </div>

  <hr>

  <h4>1. What is this study about?</h4>
  <p>Thank you for completing the research study metacognition and cognitive performance. This study aims to understand how metacognitive self-evaluation affects cognitive performance.</p>
  <p>Self-evaluation involves rating or evaluating your performance in some way. Self-evaluating while performing cognitive tasks (e.g., problem-solving tasks, memory tests) has been shown to affect performance. Generally, self-evaluation has a positive effect on cognitive performance, though this is not always the case. This research is interested in how people change their approach to problem-solving and other cognitive problems as a result of being asked to self-evaluate.</p>
  <p>The study randomly assigned participants to complete a cognitive task either with or without prompting them to self-evaluate (by asking them to provide self-report ratings of their performance). We will assess how performing this self-evaluation affected cognitive performance on the task (i.e. did it improve or impair performance). If you have any questions, now or at a later time, please feel free to contact Dr Kit Double (kit.double@sydney.edu.au).</p>
  <p>The ethical aspects of this study have been approved by the Human Research Ethics Committee (HREC) of The University of Sydney 2022/796 according to the National Statement on Ethical Conduct in Human Research (2007).</p>
  <p>If you are concerned about the way this study is being conducted or you wish to make a complaint to someone independent from the study, please contact the University:</p>
  <p>
    Human Ethics Manager<br>
    human.ethics@sydney.edu.au<br>
    +61 2 8627 8176
  </p>

  <p class="pis-keep-note">This debrief statement is for you to keep</p>

  <div class="pis-footer">
    HREC Approval No.: 2022/796 &nbsp; <span class="pis-version">Version 2, 3 November 2022</span>
  </div>
</div>`;
}

import htmlButtonResponse from "@jspsych/plugin-html-button-response";
import { compensation, recruitment } from "../context.js";
import logoUrl from "./assets/usyd-logo.png";
import "./consent.css";

// Participant Information Statements and consent, approved under HREC
// 2022/796. The wording is ethics-approved: don't edit it. Only the study
// length and the credit or payment change between studies, and those come
// from the `minutes` option (see compensation() in context.js). Any other change needs an ethics amendment and a new
// version here.

/**
 * The consent form for this link's participants (Prolific or SONA), filled
 * in with the study length and the credit or payment it works out to.
 */
export function consent({ minutes } = {}) {
  const name = recruitment();
  if (name !== "sona" && name !== "prolific") {
    throw new Error("There's no approved consent form for in-lab studies yet. Ask the researcher for their ethics-approved wording.");
  }
  const pay = compensation(minutes);
  if (!pay) {
    throw new Error("consent({ minutes }) needs how long the study takes, in minutes, so the form can show the length and credit or payment.");
  }
  if (name === "sona") return consentTrial(sonaPis(pay), "2022/796 SONA v11 (3 March 2026)");
  if (name === "prolific") return consentTrial(prolificPis(pay), "2022/796 Prolific v11 (3 March 2026)");
  throw new Error("There's no approved consent form for in-lab studies yet. Ask the researcher for their ethics-approved wording.");
}

function consentTrial(stimulus, form) {
  return {
    name: "Consent",
    type: htmlButtonResponse,
    stimulus,
    choices: ["Next"],
    data: { consent_form: form },
    // Record which form was shown (consent_form), not its full HTML.
    save_trial_parameters: { stimulus: false },
  };
}

function sonaPis({ minutes, credit }) {
  return `
<div class="pis-container">
  <div class="pis-header">
    <div>
      <h1>Participant Information Statement</h1>
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
  <p>We are conducting a research study about how people monitor and control their cognitive performance. This will help us understand how people adapt, monitor and respond during cognitive tasks. Taking part in this study is voluntary.</p>
  <p>Please read this sheet carefully and ask questions about anything that you don't understand or want to know more about.</p>

  <h4>2. Who is running the study?</h4>
  <p>The study is being carried out by the following researchers:</p>
  <ul>
    <li>Dr Kit Double, Research Fellow, School of Psychology, University of Sydney</li>
    <li>Professor Damian Birney, School of Psychology, University of Sydney</li>
    <li>Associate Professor Micah Goldwater, Lecturer, School of Psychology, University of Sydney</li>
    <li>Professor Evan Livesey, School of Psychology, University of Sydney</li>
    <li>Dr Hilary Don, Research Officer, School of Psychology, University of Sydney</li>
    <li>Dr Dominic Tran, Research Fellow, School of Psychology, University of Sydney</li>
    <li>Ms Cynthia Feng, PhD Student, School of Psychology, University of Sydney</li>
    <li>Ms Yueting Zhan, PhD Student, School of Psychology, University of Sydney</li>
    <li>Ms Mariya Bartosh, PhD Student, School of Psychology, University of Sydney</li>
    <li>Ms Sheng-Ling Chang, PhD Student, School of Psychology, University of Sydney</li>
    <li>Mr Liam Gialdi, MSc Student, Faculty of Medicine &amp; Health, University of Sydney</li>
    <li>Ms Natalie Liu, Honours Student, School of Psychology, University of Sydney</li>
    <li>Ms Michelle Dao, Honours Student, School of Psychology, University of Sydney</li>
    <li>Ms Isabella Evangelista, Honours Student, School of Psychology, University of Sydney</li>
    <li>Ms Ju Won Lee, Honours Student, School of Psychology, University of Sydney</li>
    <li>Mr Riley Leckie, Research Assistant, School of Psychology, University of Sydney</li>
    <li>Ms Imann Mian, Research Assistant, School of Psychology, University of Sydney</li>
    <li>Mr Felix Pfeifer, Research Assistant, School of Psychology, University of Sydney</li>
    <li>Mr Aditya Sridhar, Research Assistant, School of Psychology, University of Sydney</li>
    <li>Mr Riley Landfear, Research Assistant, School of Psychology, University of Sydney</li>
    <li>Mr Eoin Shepherd, Denison Student, School of Psychology, University of Sydney</li>
    <li>Ms Lina Kim, Denison Student, School of Psychology, University of Sydney</li>
  </ul>
  <p>Data from this study may form the basis of the PhD theses of Mariya Bartosh, Yueting Zhan and Cynthia Feng as well as the Honours theses of Natalie Liu, Michelle Dao, Isabella Evangelista, and Ju Won Lee.</p>
  <p>This study is being funded by the Australian Research Council Discovery Program (DE230101223).</p>

  <h4>3. What will the study involve for me?</h4>
  <p>If you decide to take part in this study, you will be asked to complete several computerised cognitive tasks and answer a number of surveys about yourself.</p>
  <p>The study will take approximately <b>${minutes}</b> minutes to complete. The study will be completed online.</p>

  <h4>4. Can I withdraw once I've started?</h4>
  <p>By participating in this study, you are providing your consent for us to collect information about you. Being in this study is completely voluntary and you do not have to take part. Your decision will not affect your current or future relationship with the researchers or anyone else at The University of Sydney.</p>
  <p>You can withdraw by closing the study website on your computer. If you decide to withdraw, we will not collect any more information from you. Any information that we have already collected will be kept in our study records and may be included in the study results. If you would prefer that we remove information that we have already collected from you, please contact Dr Kit Double (kit.double@sydney.edu.au). If you do not submit a completed response you will not receive any compensation.</p>

  <h4>5. Are there any risks or costs?</h4>
  <p>Aside from giving up your time, we do not expect that there will be any risks or costs associated with taking part in this study.</p>

  <h4>6. Are there any benefits?</h4>
  <p>Course credit will be awarded to you after your participation, as indicated by your psychology unit of study syllabus. The study will take approximately <b>${minutes}</b> minutes and you will receive <b>${credit}</b> course credit.</p>
  <p>If you do not wish to complete this study, you may obtain course credit by doing other studies on SONA or by undertaking an alternative assignment.</p>

  <h4>7. What will happen to information that is collected?</h4>
  <p>By participating in this study, you are providing your consent for us to collect information about you for the purposes of this study.</p>
  <p>Any information you provide us will be stored securely and we will only disclose it with your permission, unless we are required by law to release information. We are planning for the study findings to be published. You will not be individually identifiable in these publications.</p>
  <p>We will keep the information we collect for this study, and we may use it in future projects.</p>
  <p>By providing your consent you are allowing us to use your information in future projects. We don't know at this stage what these other projects will involve. We will seek ethical approval before using the information in these future projects.</p>
  <p>We intend to submit the information from this project to a public database for research information, so that other researchers can access it and use it in their projects. Before we do so, we will take out all the identifying information so that the people we give it to won't know whose information it is. They won't know that you participated in the study and they won't be able to link you to any of the information you provided.</p>

  <h4>8. Will I be told the results of the study?</h4>
  <p>You have a right to receive feedback about the overall results of this study. To receive feedback about the overall results of the study please email Dr Kit Double (<a href="mailto:kit.double@sydney.edu.au">kit.double@sydney.edu.au</a>). This feedback will be in the form of a brief lay summary.</p>

  <h4>9. What if I would like further information?</h4>
  <p>When you have read this information, the following researcher/s will be available to discuss it with you further and answer any questions you may have:</p>
  <ul>
    <li>Dr Kit Double, Research Fellow, School of Psychology, University of Sydney. Phone: +61 2 8627 8636 | Email: kit.double@sydney.edu.au</li>
  </ul>

  <h4>10. What if I have a complaint or any concerns?</h4>
  <p>The ethical aspects of this study have been approved by the Human Research Ethics Committee (HREC) of The University of Sydney [2022/796] according to the National Statement on Ethical Conduct in Human Research (2007). If you are concerned about the way this study is being conducted or you wish to make a complaint to someone independent from the study, please contact the University:</p>
  <p>
    Human Ethics Manager<br>
    human.ethics@sydney.edu.au<br>
    +61 2 8627 8176
  </p>

  <p class="pis-keep-note">This information sheet is for you to keep</p>

  <div class="pis-consent">
    <p><strong>I confirm the following:</strong></p>
    <p>I consent to participate in this study</p>
  </div>

  <div class="pis-footer">
    HREC Approval No.: 2022/796 &nbsp; <span class="pis-version">Version 11, 3 March 2026</span>
  </div>
</div>`;
}

function prolificPis({ minutes, payment }) {
  return `
<div class="pis-container">
  <header class="pis-header">
    <div class="pis-header-text">
      <h1>Participant Information Statement</h1>
      <h2 class="pis-title-study">Research Study: Metacognition and Cognitive Performance</h2>
      <div class="pis-contact">
        <div>Dr Kit Double (Responsible Researcher)</div>
        <div>School of Psychology, Faculty of Science</div>
        <div>Phone: +61 2 8627 8636</div>
        <div>Email: <a href="mailto:kit.double@sydney.edu.au">kit.double@sydney.edu.au</a></div>
      </div>
    </div>
    <img class="pis-logo" alt="University of Sydney" src="${logoUrl}">
  </header>

  <hr>

  <section>
    <h4>1. What is this study about?</h4>
    <p>We are conducting a research study about how people monitor and control their cognitive performance. This will help us understand how people adapt, monitor and respond during cognitive tasks. Taking part in this study is voluntary.</p>
    <p>Please read this sheet carefully and ask questions about anything that you don't understand or want to know more about.</p>
  </section>

  <section>
    <h4>2. Who is running the study?</h4>
    <p>The study is being carried out by the following researchers:</p>
    <ul>
      <li>Dr Kit Double, Research Fellow, School of Psychology, University of Sydney</li>
      <li>Professor Damian Birney, School of Psychology, University of Sydney</li>
      <li>Associate Professor Micah Goldwater, Lecturer, School of Psychology, University of Sydney</li>
      <li>Professor Evan Livesey, School of Psychology, University of Sydney</li>
      <li>Dr Hilary Don, Research Officer, School of Psychology, University of Sydney</li>
      <li>Dr Dominic Tran, Research Fellow, School of Psychology, University of Sydney</li>
      <li>Ms Cynthia Feng, PhD Student, School of Psychology, University of Sydney</li>
      <li>Ms Yueting Zhan, PhD Student, School of Psychology, University of Sydney</li>
      <li>Ms Mariya Bartosh, PhD Student, School of Psychology, University of Sydney</li>
      <li>Ms Sheng-Ling Chang, PhD Student, School of Psychology, University of Sydney</li>
      <li>Mr Liam Gialdi, MSc Student, Faculty of Medicine &amp; Health, University of Sydney</li>
      <li>Ms Natalie Liu, Honours Student, School of Psychology, University of Sydney</li>
      <li>Ms Michelle Dao, Honours Student, School of Psychology, University of Sydney</li>
      <li>Ms Isabella Evangelista, Honours Student, School of Psychology, University of Sydney</li>
      <li>Ms Ju Won Lee, Honours Student, School of Psychology, University of Sydney</li>
      <li>Mr Riley Leckie, Research Assistant, School of Psychology, University of Sydney</li>
      <li>Ms Imann Mian, Research Assistant, School of Psychology, University of Sydney</li>
      <li>Mr Felix Pfeifer, Research Assistant, School of Psychology, University of Sydney</li>
      <li>Mr Aditya Sridhar, Research Assistant, School of Psychology, University of Sydney</li>
      <li>Mr Riley Landfear, Research Assistant, School of Psychology, University of Sydney</li>
      <li>Mr Eoin Shepherd, Denison Student, School of Psychology, University of Sydney</li>
      <li>Ms Lina Kim, Denison Student, School of Psychology, University of Sydney</li>
    </ul>
    <p>Data from this study may form the basis of the PhD theses of Mariya Bartosh, Yueting Zhan, Sheng-Ling Chang and Cynthia Feng, the Masters thesis of Liam Gialdi, as well as the Honours theses of Natalie Liu, Michelle Dao, Isabella Evangelista and Ju Won Lee.</p>
    <p>This study is being funded by the Australian Research Council Discovery Program (DE230101223).</p>
  </section>

  <section>
    <h4>3. What will the study involve for me?</h4>
    <p>If you decide to take part in this study, you will be asked to complete several computerised cognitive tasks and answer a number of surveys about yourself.</p>
    <p>The study will take approximately ${minutes}&nbsp;minutes to complete. The study will be completed online.</p>
  </section>

  <section>
    <h4>4. Can I withdraw once I've started?</h4>
    <p>By participating in this study, you are providing your consent for us to collect information about you. Being in this study is completely voluntary and you do not have to take part. Your decision will not affect your current or future relationship with the researchers or anyone else at The University of Sydney.</p>
    <p>You can withdraw by closing the study website on your computer. If you decide to withdraw, we will not collect any more information from you. Any information that we have already collected will be kept in our study records and may be included in the study results. If you would prefer that we remove information that we have already collected from you, please contact Dr Kit Double (<a href="mailto:kit.double@sydney.edu.au">kit.double@sydney.edu.au</a>). If you do not submit a completed response you will not receive any compensation.</p>
  </section>

  <section>
    <h4>5. Are there any risks or costs?</h4>
    <p>Aside from giving up your time, we do not expect that there will be any risks or costs associated with taking part in this study.</p>
  </section>

  <section>
    <h4>6. Are there any benefits?</h4>
    <p>The study will take approximately ${minutes}&nbsp;minutes and you will receive ${payment} compensation for completion. If you do not submit a completed response you will not receive any compensation.</p>
  </section>

  <section>
    <h4>7. What will happen to information that is collected?</h4>
    <p>By participating in this study, you are providing your consent for us to collect information about you for the purposes of this study.</p>
    <p>Any information you provide us will be stored securely and we will only disclose it with your permission, unless we are required by law to release information. We are planning for the study findings to be published. You will not be individually identifiable in these publications.</p>
    <p>We will keep the information we collect for this study, and we may use it in future projects.</p>
    <p>By providing your consent you are allowing us to use your information in future projects. We don't know at this stage what these other projects will involve. We will seek ethical approval before using the information in these future projects.</p>
    <p>We intend to submit the information from this project to a public database for research information, so that other researchers can access it and use it in their projects. Before we do so, we will take out all the identifying information so that the people we give it to won't know whose information it is. They won't know that you participated in the study and they won't be able to link you to any of the information you provided.</p>
  </section>

  <section>
    <h4>8. Will I be told the results of the study?</h4>
    <p>You have a right to receive feedback about the overall results of this study. To receive feedback about the overall results of the study please email Dr Kit Double (<a href="mailto:kit.double@sydney.edu.au">kit.double@sydney.edu.au</a>). This feedback will be in the form of a brief lay summary.</p>
  </section>

  <section>
    <h4>9. What if I would like further information?</h4>
    <p>When you have read this information, the following researcher/s will be available to discuss it with you further and answer any questions you may have:</p>
    <ul>
      <li>Dr Kit Double, Research Fellow, School of Psychology, University of Sydney. Phone: +61 2 8627 8636 | Email: <a href="mailto:kit.double@sydney.edu.au">kit.double@sydney.edu.au</a></li>
    </ul>
  </section>

  <section>
    <h4>10. What if I have a complaint or any concerns?</h4>
    <p>The ethical aspects of this study have been approved by the Human Research Ethics Committee (HREC) of The University of Sydney [2022/796] according to the National Statement on Ethical Conduct in Human Research (2007). If you are concerned about the way this study is being conducted or you wish to make a complaint to someone independent from the study, please contact the University:</p>
    <p class="pis-address">
      Human Ethics Manager<br>
      <a href="mailto:human.ethics@sydney.edu.au">human.ethics@sydney.edu.au</a><br>
      +61 2 8627 8176
    </p>
  </section>

  <p class="pis-keep-note">This information sheet is for you to keep</p>

  <div class="pis-consent">
    <p class="pis-consent-heading"><strong>I confirm the following:</strong></p>
    <p id="pis-consent-label">I consent to participate in this study</p>
  </div>

  <footer class="pis-footer">
    HREC Approval No.: 2022/796 <span class="pis-sep">·</span> <span class="pis-version">Version 11, 3 March 2026</span>
  </footer>
</div>`;
}

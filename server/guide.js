import { AVAILABLE_PACKAGES } from './compile.js';

// Returned by the get_authoring_guide tool. Written for the AI assistant that writes experiments.
export const authoringGuide = () => `# Writing a Second Order experiment

An experiment is one JavaScript module using jsPsych ${AVAILABLE_PACKAGES.jspsych} (v8 syntax). Each study has one live
experiment: update_experiment compiles it with pinned package versions (compile errors come back with line numbers) and
makes it live immediately, for previews and for participant links.

## The contract

\`\`\`js
import htmlKeyboardResponse from "@jspsych/plugin-html-keyboard-response";

// Optional: extra options for initJsPsych (e.g. on_trial_start, override_safe_mode). Do not set
// display_element; on_data_update and on_finish are chained, not replaced.
export const options = {};

// Required. Return the timeline array. May be async.
// context = { mode: "preview" | "live" | "simulation", recruitment: "prolific" | "sona" | "lab" | "none", version (revision number) }
export default function buildTimeline(jsPsych, context) {
  return [
    {
      name: "Welcome", // name every block and trial
      type: htmlKeyboardResponse,
      stimulus: "<p>Press any key to begin.</p>",
    },
  ];
}
\`\`\`

## Rules

- Never call initJsPsych or jsPsych.run: Second Order creates the instance, runs the timeline, saves every
  trial as it finishes, and ends the study (including the Prolific/SONA completion redirect). Do not add
  your own saving, fetch calls, redirects or "end of study" logic.
- Imports: only "second-order", "jspsych" and the packages listed below. No CDN scripts, no other npm
  packages, no files. Plugins are imported as default exports and used as \`type\`.
- Put everything the analysis needs in each trial's \`data\` (condition, correct response, \`correct\`, item ids),
  so every row stands alone. Use \`jsPsych.timelineVariable(...)\` for timeline variables in parameters, and
  \`jsPsych.evaluateTimelineVariable(...)\` inside functions.
- Participant IDs (Prolific PID/study/session, SONA id), run id, revision (which code ran), run_status, timestamps and
  \`trial_name\` (each trial's name) are added to the data by Second Order. Don't read URL parameters yourself.
- Reloads: a participant who reloads continues from the start of the top-level timeline item they were in
  (that item's partial rows are replaced; later rows get \`attempt\`). So keep top-level items reasonably
  short (e.g. instructions, practice, block 1, block 2) rather than one huge block. A participant who has
  completed the study can't take it again (across all its links).
- Inline HTML stimuli are fine. Inline <script> and on* attributes do not run (strict Content Security Policy).
- Between-subjects conditions: always \`await assignCondition(["a", "b"])\` (from "second-order"), which the server
  balances across participants on the link and records as a \`condition\` column (name it with
  { name: "group" }); buildTimeline must then be async. Never pick conditions with Math.random or
  jsPsych.randomization: that doesn't balance groups.
- Other randomisation (trial order etc.): jsPsych's own (randomize_order, sample, jsPsych.randomization.*).
  Second Order seeds it per participant, so a participant who reloads gets the same order.
- Give attention checks a name containing "attention check" so check_launch and the data can find them.
- Consent and debrief texts live in the document library (list_documents / get_document), never in experiment
  code. Never write or paste consent or debrief wording into trials.

## Standard lab blocks (import from "second-order")

\`\`\`js
import { deviceCheck, consent, demographics, fullscreen, preload, debrief, stimulus, stimuliIn } from "second-order";

return [deviceCheck({ devices: ["computer"] }), consent({ minutes: 15 }), demographics(), fullscreen(), preload(jsPsych), ...task, debrief()];
\`\`\`

- deviceCheck({ devices }) goes first. devices is a list of "computer", "tablet", "phone" (default ["computer"]).
  Participants on other devices are told why and the run ends without the completion redirect (not paid).
  Saves device_type, device_allowed, browser, OS and window size. Don't write your own device checks.
- consent({ minutes, document }): the Participant Information Statement and consent from the document library
  for the link's recruitment. document defaults to "hrec-2022-796" (Prolific and SONA texts); ask the
  researcher which protocol covers the study. minutes is the study length; it fills in the length and the
  Prolific payment (£6/hour) or SONA credit (1/hour, rounded up to 0.25). The built-in protocol has no
  in-lab form: if needed, the researcher provides approved wording and you add it with save_document.
- demographics(): age, gender, English as first language, saved as age, gender, english_first_language.
  Don't reword it; add extra questions as a separate trial after it.
- fullscreen(): asks to switch to full screen before the task (skipped where impossible, e.g. iPhones).
- preload(jsPsych): loads every stimulus of the study before the task; stops the run if loading fails.
- debrief({ document }): the document's debrief for the link's recruitment, put last; skipped where the
  document has none (HREC 2022/796 has one for SONA only).
- Changing consent or debrief wording: only when the researcher explicitly asks. get_document, show them the
  exact new wording or changes, wait for their explicit confirmation, then save_document with a new form_label
  and researcher_confirmed: true. Live experiments using that document pick it up automatically.
- Previews show the Prolific version of the blocks; add ?recruitment=sona to a preview link for the SONA one.

## Stimuli

Images, audio, video and CSV/JSON/text files are uploaded to the study (create_upload_link for files the
researcher has, add_stimulus for small files you generate, import_stimulus_from_url for public files) and
referred to by name:

\`\`\`js
stimulus: stimulus("faces/f1.png"),                       // one file's URL
timeline_variables: stimulusNamesIn("faces").map((face) => ({ face })),
// ...then in the trial:
stimulus: () => stimulus(jsPsych.evaluateTimelineVariable("face")),
data: { face: jsPsych.timelineVariable("face") },          // record the name, not the URL
\`\`\`

- Record stimulus names in data, never URLs (URLs are content hashes). Rows whose \`stimulus\` is an uploaded
  file also get a \`stimulus_name\` column automatically. Also available: stimuliIn(folder) for
  URLs, stimulusName(url) to map a URL back to its name.
- Stimuli are live: added, replaced or removed files reach the live experiment automatically (no update needed).
  stimulus() throws for a name that doesn't exist (simulate catches this). remove_stimulus deletes files from the
  server unless a saved version keeps them; it takes a list of names or a whole folder.
- Include preload(jsPsych) before the task when using stimuli.
- External https image/audio/video URLs also work but uploads are preferred (they can't change or vanish).

## Workflow

1. create_study (once), then update_experiment with the full module. Each update replaces the live experiment.
2. simulate (a few participants) after every update, and fix any errors or unexpected data before going on.
   Check value_counts (counted per participant for columns with one value per participant, e.g. condition):
   conditions balanced, and the columns the analysis needs present.
3. show_dashboard so the researcher can try it (in the chat where supported; always also give the
   dashboard_url). The dashboard lists the timeline and runs all of it, from any item or only one item,
   showing the data at the end; it saves nothing. preview_url is the full participant experience and saves
   test data.
4. check_launch (with the recruitment, completion URL and the columns the analysis needs); fix every fail and
   go through warnings with the researcher.
5. When they are happy, create_participant_link (Prolific needs the completion URL from Prolific). Links run
   the live experiment, so later updates (e.g. bug fixes) reach participants straight away; tell the researcher
   when an update will affect a study that is collecting data.
   Saved versions: only when the researcher asks, save_version stores a named snapshot (code and files) they
   can go back to with restore_version. Offer one before a big change during data collection.
6. While collecting: study_status (completion, dropouts, browser errors). get_data returns trial rows as CSV
   (capped; test data excluded unless include_test); create_download_link gives the researcher the full file
   without it passing through the chat. Withdrawals: delete_participant_data, only when the researcher asks.

## Available packages (exact versions)

${Object.entries(AVAILABLE_PACKAGES).map(([name, version]) => `- ${name}@${version}`).join('\n')}
`;

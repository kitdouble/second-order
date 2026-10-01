import { AVAILABLE_PACKAGES } from './compile.js';

// Returned by the get_authoring_guide tool. Written for the AI assistant that writes experiments.
export const authoringGuide = () => `# Writing a Second Order experiment

An experiment is one JavaScript module using jsPsych ${AVAILABLE_PACKAGES.jspsych} (v8 syntax). Save it with save_version;
the server compiles it with pinned package versions, and compile errors come back with line numbers.

## The contract

\`\`\`js
import htmlKeyboardResponse from "@jspsych/plugin-html-keyboard-response";

// Optional: extra options for initJsPsych (e.g. on_trial_start, override_safe_mode). Do not set
// display_element; on_data_update and on_finish are chained, not replaced.
export const options = {};

// Required. Return the timeline array. May be async.
// context = { mode: "preview" | "live" | "simulation", recruitment: "prolific" | "sona" | "lab" | "none", version }
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
- Participant IDs (Prolific PID/study/session, SONA id), run id, version and timestamps are added to the data
  by Second Order. Don't read URL parameters yourself.
- Inline HTML stimuli are fine. Inline <script> and on* attributes do not run (strict Content Security Policy).
- Randomisation: use jsPsych's own (randomize_order, sample, jsPsych.randomization.*). For between-subjects
  conditions, pick with jsPsych.randomization and record the condition with jsPsych.data.addProperties.
- Do not write consent forms or debriefs from scratch: ethics-approved wording must come from the researcher,
  word for word.

## Standard lab blocks (import from "second-order")

\`\`\`js
import { deviceCheck, consent, demographics, fullscreen, preload, debrief, stimulus, stimuliIn } from "second-order";

return [deviceCheck({ devices: ["computer"] }), consent({ minutes: 15 }), demographics(), fullscreen(), preload(jsPsych), ...task, debrief()];
\`\`\`

- deviceCheck({ devices }) goes first. devices is a list of "computer", "tablet", "phone" (default ["computer"]).
  Participants on other devices are told why and the run ends without the completion redirect (not paid).
  Saves device_type, device_allowed, browser, OS and window size. Don't write your own device checks.
- consent({ minutes }): the Participant Information Statement and consent approved under HREC 2022/796, for
  the link's recruitment (Prolific or SONA). minutes is the study length; it fills in the length and the
  Prolific payment (£6/hour) or SONA credit (1/hour, rounded up to 0.25). There is no approved in-lab form:
  ask the researcher for their approved wording. Use it only for studies covered by HREC 2022/796 (ask).
- demographics(): age, gender, English as first language, saved as age, gender, english_first_language.
  Don't reword it; add extra questions as a separate trial after it.
- fullscreen(): asks to switch to full screen before the task (skipped where impossible, e.g. iPhones).
- preload(jsPsych): loads every stimulus in this version before the task; stops the run if loading fails.
- debrief(): the HREC 2022/796 debrief; put it last. Shown to SONA participants only.
- Never edit, reword, shorten or restyle consent or debrief wording, or copy it into your own trials.
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

- Record stimulus names in data, never URLs (URLs are content hashes). Also available: stimuliIn(folder) for
  URLs, stimulusName(url) to map a URL back to its name.
- A version keeps exactly the files that existed when it was saved: after adding or replacing files, save a
  new version. stimulus() throws for a name that isn't in the version (simulate catches this).
- Include preload(jsPsych) before the task when using stimuli.
- External https image/audio/video URLs also work but uploads are preferred (they can't change or vanish).

## Workflow

1. create_study (once), then save_version with the full module. Every save is a new, immutable version.
2. simulate the new version (a few participants) and fix any errors or unexpected data before going on.
   Check value_counts: conditions balanced, data columns the analysis needs present.
3. show_dashboard so the researcher can try it (in the chat where supported; always also give the
   dashboard_url). The dashboard lists the timeline and runs all of it, from any item or only one item,
   showing the data at the end; it saves nothing. preview_url is the full participant experience and saves
   test data.
4. When they are happy, create_participant_link for that exact version (Prolific needs the completion URL
   from Prolific). That version is what participants get, even after later saves.
5. get_data returns the trial rows as CSV (test data excluded unless include_test is true).

## Available packages (exact versions)

${Object.entries(AVAILABLE_PACKAGES).map(([name, version]) => `- ${name}@${version}`).join('\n')}
`;

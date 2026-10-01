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
// context = { mode: "preview" | "live", version: number }
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
- Imports: only "jspsych" and the packages listed below. No CDN scripts, no other npm packages, no files.
  Plugins are imported as default exports and used as \`type\`.
- Put everything the analysis needs in each trial's \`data\` (condition, correct response, \`correct\`, item ids),
  so every row stands alone. Use \`jsPsych.timelineVariable(...)\` for timeline variables in parameters, and
  \`jsPsych.evaluateTimelineVariable(...)\` inside functions.
- Participant IDs (Prolific PID/study/session, SONA id), run id, version and timestamps are added to the data
  by Second Order. Don't read URL parameters yourself.
- Stimuli: images, audio and video can be https URLs for now (stimulus uploads are coming). Inline HTML
  stimuli are fine. Inline <script> and on* attributes do not run (strict Content Security Policy).
- Randomisation: use jsPsych's own (randomize_order, sample, jsPsych.randomization.*). For between-subjects
  conditions, pick with jsPsych.randomization and record the condition with jsPsych.data.addProperties.
- Do not write consent forms or debriefs from scratch: ethics-approved wording must come from the researcher,
  word for word.

## Workflow

1. create_study (once), then save_version with the full module. Every save is a new, immutable version.
2. Give the researcher the preview_url to try. Preview data is stored as test data.
3. When they are happy, create_participant_link for that exact version (Prolific needs the completion URL
   from Prolific). That version is what participants get, even after later saves.
4. get_data returns the trial rows as CSV (test data excluded unless include_test is true).

## Available packages (exact versions)

${Object.entries(AVAILABLE_PACKAGES).map(([name, version]) => `- ${name}@${version}`).join('\n')}
`;

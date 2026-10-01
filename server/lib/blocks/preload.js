import htmlKeyboardResponse from "@jspsych/plugin-html-keyboard-response";
import preloadPlugin from "@jspsych/plugin-preload";
import { allStimuli, fileName } from "../stimuli.js";
import { stopMessage } from "./stop.js";

// Give up after this long; big videos on a slow connection take a while.
const MAX_LOAD_MINUTES = 5;

/**
 * Loads every image, audio and video file in the study's stimuli before the task,
 * with a progress bar, so no trial waits on a download. Put it just before
 * the task (after fullscreen()). Saves `success`, `timeout`, `failed_files`
 * (stimulus names) and `load_time_ms`.
 *
 * If anything fails to load, the run stops there: the participant is told,
 * and isn't sent to the completion link (see stop.js).
 */
export function preload(jsPsych) {
  let loaded = null;
  let started = 0;
  let failed = [];
  return {
    name: "Preload",
    timeline: [
      {
        name: "Load stimuli",
        type: preloadPlugin,
        ...allStimuli(),
        message: "<p>Loading the study…</p><p>This can take a minute on a slow connection.</p>",
        show_progress_bar: true,
        // End the trial on failure (instead of leaving the error on screen
        // for good) so the failure is recorded and the run stops properly.
        continue_after_error: true,
        max_load_time: MAX_LOAD_MINUTES * 60 * 1000,
        on_start: () => {
          started = performance.now();
          failed = [];
        },
        // The plugin's own failed_images/audio/video lists rely on a browser
        // feature Chrome has removed, so they're usually empty. Record the
        // failed files here instead.
        on_error: (file) => failed.push(fileName(file)),
        on_finish: (data) => {
          data.load_time_ms = Math.round(performance.now() - started);
          data.failed_files = failed;
          delete data.failed_images;
          delete data.failed_audio;
          delete data.failed_video;
          loaded = data.success;
        },
      },
      {
        name: "Stop if loading failed",
        conditional_function: () => loaded === false,
        timeline: [
          {
            name: "Loading failed message",
            type: htmlKeyboardResponse,
            stimulus: "",
            choices: "NO_KEYS",
            on_load: () => jsPsych.abortExperiment(stopMessage("preload"), { stopped: "preload" }),
          },
        ],
      },
    ],
  };
}

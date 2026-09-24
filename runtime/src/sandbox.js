// Runs inside the sandboxed frame for custom-jspsych blocks. Exposes jsPsych
// and common plugins as globals, receives the step's code from the parent
// page, and passes recorded rows back. The frame has no network access (CSP)
// and an opaque origin, so the code can only draw and record.
import { initJsPsych } from "jspsych";
import htmlKeyboard from "@jspsych/plugin-html-keyboard-response";
import htmlButton from "@jspsych/plugin-html-button-response";
import canvasKeyboard from "@jspsych/plugin-canvas-keyboard-response";
import canvasButton from "@jspsych/plugin-canvas-button-response";
import imageKeyboard from "@jspsych/plugin-image-keyboard-response";
import imageButton from "@jspsych/plugin-image-button-response";
import audioKeyboard from "@jspsych/plugin-audio-keyboard-response";
import htmlSlider from "@jspsych/plugin-html-slider-response";
import surveyLikert from "@jspsych/plugin-survey-likert";
import surveyMultiChoice from "@jspsych/plugin-survey-multi-choice";
import surveyText from "@jspsych/plugin-survey-text";
import instructions from "@jspsych/plugin-instructions";
import callFunction from "@jspsych/plugin-call-function";
import preload from "@jspsych/plugin-preload";

Object.assign(window, {
  initJsPsych,
  jsPsychHtmlKeyboardResponse: htmlKeyboard,
  jsPsychHtmlButtonResponse: htmlButton,
  jsPsychCanvasKeyboardResponse: canvasKeyboard,
  jsPsychCanvasButtonResponse: canvasButton,
  jsPsychImageKeyboardResponse: imageKeyboard,
  jsPsychImageButtonResponse: imageButton,
  jsPsychAudioKeyboardResponse: audioKeyboard,
  jsPsychHtmlSliderResponse: htmlSlider,
  jsPsychSurveyLikert: surveyLikert,
  jsPsychSurveyMultiChoice: surveyMultiChoice,
  jsPsychSurveyText: surveyText,
  jsPsychInstructions: instructions,
  jsPsychCallFunction: callFunction,
  jsPsychPreload: preload,
});

function seededRng(seed) {
  let a = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const post = (msg) => window.parent.postMessage(msg, "*");
let started = false;

window.addEventListener("message", (e) => {
  if (e.source !== window.parent || started) return;
  const m = e.data;
  if (!m || m.so !== "start" || typeof m.code !== "string") return;
  started = true;
  let finished = false;
  const api = {
    root: document.getElementById("so-root"),
    params: m.params ?? {},
    condition: m.condition ?? {},
    seed: m.seed,
    rng: seededRng(String(m.seed)),
    record(row) {
      if (finished) return;
      try {
        post({ so: "row", row: JSON.parse(JSON.stringify(row ?? {})) });
      } catch {
        post({ so: "error", message: "api.record was given something that isn't plain data." });
      }
    },
    done() {
      if (finished) return;
      finished = true;
      post({ so: "done" });
    },
  };
  window.addEventListener("error", (ev) => post({ so: "error", message: String(ev.message ?? "error") }));
  window.addEventListener("unhandledrejection", (ev) => post({ so: "error", message: String(ev.reason?.message ?? ev.reason) }));
  try {
    // eslint-disable-next-line no-new-func
    new Function("api", m.code)(api);
  } catch (err) {
    post({ so: "error", message: String(err?.message ?? err) });
  }
});

post({ so: "ready" });

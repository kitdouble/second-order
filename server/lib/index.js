// What experiments import from Second Order:
//
//   import { deviceCheck, consent, demographics, fullscreen, preload, debrief, stimulus, stimulusNamesIn } from "second-order";
//
// The lab's standard blocks (ported from the Meta Lab jsPsych kit; consent and debrief wording is
// ethics-approved under HREC 2022/796 and must not be edited) and the stimulus helpers.
export { consent } from "./blocks/consent.js";
export { debrief } from "./blocks/debrief.js";
export { demographics } from "./blocks/demographics.js";
export { deviceCheck, fullscreen } from "./blocks/device.js";
export { preload } from "./blocks/preload.js";
export { fileName as stimulusName, stimuliIn, stimulus, stimulusNamesIn } from "./stimuli.js";
export { compensation, recruitment } from "./context.js";

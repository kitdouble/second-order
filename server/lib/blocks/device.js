import browserCheck from "@jspsych/plugin-browser-check";
import fullscreenPlugin from "@jspsych/plugin-fullscreen";
import { deviceType, devicesOf } from "../devices.js";
import { stopMessage } from "./stop.js";

/**
 * Checks the participant is on an allowed device (`devices`, default
 * ["computer"]). Put it first in the timeline, before consent. If the
 * device isn't allowed, the participant sees why and the study ends without
 * the completion redirect, so they aren't paid or credited (see stop.js).
 * Saves `device_type`, `device_allowed`, the browser, OS and window size.
 */
export function deviceCheck({ devices } = {}) {
  const allowed = devicesOf(devices);
  return {
    name: "Device check",
    type: browserCheck,
    // Only quick checks: no frame-rate measurement or media device checks.
    features: ["width", "height", "browser", "browser_version", "mobile", "os", "fullscreen"],
    inclusion_function: () => allowed.includes(deviceType()),
    exclusion_message: () => stopMessage("device", allowed),
    on_finish: (data) => {
      data.device_type = deviceType();
      data.device_allowed = allowed.includes(data.device_type);
      if (!data.device_allowed) data.stopped = "device";
    },
  };
}

/**
 * Asks the participant to switch to full screen (one button press; browsers
 * only allow it after a click). Skipped where the browser can't go full
 * screen, e.g. iPhones. The study leaves full screen by itself at the end.
 */
export function fullscreen() {
  return {
    name: "Fullscreen",
    conditional_function: () => document.fullscreenEnabled || document.webkitFullscreenEnabled === true,
    timeline: [
      {
        name: "Enter full screen",
        type: fullscreenPlugin,
        fullscreen_mode: true,
        message: "<p>The study will now switch to full screen.</p><p>Please stay in full screen until the end.</p>",
        button_label: "Continue",
      },
    ],
  };
}

/** Leave full screen if the page is in it (the plugin's own exit does nothing). */
export function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
}

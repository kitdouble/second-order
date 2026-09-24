// Participant runtime entry point. Deterministic: everything participants see
// comes from the compiled spec. No AI, no improvisation.
import { initJsPsych } from "jspsych";
import { escapeHtml } from "@so/core";
import { RENDERERS, flushNode } from "./blocks.js";
import { postJson, createUploader } from "./net.js";
import { createTimingMonitor } from "./timing.js";

const root = document.getElementById("so-root");

function message(html) {
  root.innerHTML = `<div class="so-text so-message">${html}</div>`;
}

async function main() {
  const parts = location.pathname.split("/").filter(Boolean); // ["s", "<hash>"]
  const hash = parts[1];
  const qs = new URLSearchParams(location.search);
  message("<p>Loading the study...</p>");

  let start;
  try {
    start = await postJson("/sessions", {
      hash,
      pid: qs.get("PROLIFIC_PID") || undefined,
      prolific_study_id: qs.get("STUDY_ID") || undefined,
      prolific_session_id: qs.get("SESSION_ID") || undefined,
      preview: qs.get("preview") || undefined,
      cond: qs.get("cond") || undefined,
    });
  } catch {
    return message("<p>We couldn't reach the study server. Please check your connection and reload this page.</p>");
  }
  if (!start.ok) return message(`<p>${escapeHtml(start.error)}</p>`);

  const preview = start.phase === "preview";
  const plan = start.plan;
  if (preview && qs.get("quick")) {
    for (const s of plan.steps) if (s.params.staircase || s.block.startsWith("choice-rt")) s.items = s.items.slice(0, 6);
  }

  const timing = createTimingMonitor();
  await timing.measureRefresh();
  const uploader = createUploader(start.session_id);
  const startedAt = performance.now();
  let declined = false;

  if (preview) {
    const banner = document.createElement("div");
    banner.className = "so-preview";
    banner.textContent = `Preview · ${start.condition} · data is kept separate and never analysed`;
    document.body.prepend(banner);
  }

  const jsPsych = initJsPsych({
    display_element: root,
    on_finish: async () => {
      message("<p>Saving your responses. Please don't close this window...</p>");
      const saved = await uploader.flushAll();
      let done;
      try {
        done = await postJson(`/sessions/${start.session_id}/complete`, {
          status: declined ? "declined" : "complete",
          minutes: (performance.now() - startedAt) / 60000,
          meta: timing.snapshot(),
        });
      } catch {
        done = { ok: false };
      }
      if (declined) return message("<p>You chose not to take part. Please return this study on Prolific. You can now close this window.</p>");
      if (!saved || !done.ok) {
        return message("<p>Some of your responses could not be saved. Please don't close this window yet; reload the page to try again, or contact the researcher through Prolific.</p>");
      }
      if (done.redirect_url && !preview) {
        message("<p>Thank you! Taking you back to Prolific...</p>");
        setTimeout(() => (location.href = done.redirect_url), 800);
      } else {
        message(`<p>Thank you, you have finished.${preview ? " (Preview: no redirect.)" : " You can now close this window."}</p>`);
      }
    },
  });

  const ctx = {
    seed: start.seed,
    levels: plan.levels,
    preview,
    finish: () => jsPsych.finishTrial(),
    stairs: {},
    timing,
    record(step, index, data) {
      if (step.params.record === false) return;
      uploader.add(step.id, index, data);
    },
    decline() {
      declined = true;
      jsPsych.abortExperiment("");
    },
  };

  const timeline = [];
  for (const step of plan.steps) {
    const render = RENDERERS[step.block];
    if (!render) return message(`<p>This study uses a block this runtime doesn't know (${escapeHtml(step.block)}).</p>`);
    const nodes = render(step, ctx);
    // Send what we have at the end of every step.
    nodes.push(flushNode(() => uploader.flush()));
    timeline.push(...nodes);
  }
  root.innerHTML = "";
  jsPsych.run(timeline.filter(Boolean));
}

main();

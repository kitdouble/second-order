// Turns compiled plan steps into jsPsych timeline nodes. One renderer per
// block ref; the block's data columns are defined in @so/core.
import htmlButton from "@jspsych/plugin-html-button-response";
import htmlKeyboard from "@jspsych/plugin-html-keyboard-response";
import canvasKeyboard from "@jspsych/plugin-canvas-keyboard-response";
import instructionsPlugin from "@jspsych/plugin-instructions";
import surveyLikert from "@jspsych/plugin-survey-likert";
import { createStaircase, makeRng, textToHtml, escapeHtml } from "@so/core";

const textPage = (html) => `<div class="so-text">${html}</div>`;

function consent(step, ctx) {
  const p = step.params;
  return [
    {
      type: htmlButton,
      stimulus: textPage(`<h2>${escapeHtml(p.title)}</h2>${textToHtml(p.text)}`),
      choices: [p.agree_label, p.decline_label],
      on_finish: (data) => {
        const consented = data.response === 0;
        ctx.record(step, 0, { consented, rt: Math.round(data.rt) });
        if (!consented) ctx.decline();
      },
    },
  ];
}

function instructions(step, ctx) {
  const p = step.params;
  return [
    {
      type: instructionsPlugin,
      pages: p.pages.map((t) => textPage(textToHtml(t))),
      show_clickable_nav: true,
      allow_backward: p.allow_back,
      allow_keys: false,
      button_label_next: "Next",
      button_label_previous: "Back",
      on_finish: (data) => ctx.record(step, 0, { rt: Math.round(data.rt) }),
    },
  ];
}

function attention(step, ctx) {
  const p = step.params;
  return [
    {
      type: htmlButton,
      stimulus: textPage(textToHtml(p.item)),
      choices: p.options,
      button_layout: "flex",
      on_finish: (data) => {
        const response = p.options[data.response];
        ctx.record(step, 0, { response, passed: response === p.correct, rt: Math.round(data.rt) });
      },
    },
  ];
}

function likert(step, ctx) {
  const p = step.params;
  const byId = Object.fromEntries(p.items.map((it) => [it.id, it]));
  return [
    {
      type: surveyLikert,
      preamble: p.preamble ? textPage(textToHtml(p.preamble)) : null,
      questions: step.items.map((it) => ({
        prompt: escapeHtml(byId[it.item_id].text),
        labels: p.scale.labels,
        required: true,
        name: it.item_id,
      })),
      scale_width: 700,
      on_finish: (data) => {
        step.items.forEach((it, i) => {
          ctx.record(step, i, {
            item_id: it.item_id,
            response: p.scale.min + data.response[it.item_id],
            reverse: it.reverse,
            rt: Math.round(data.rt),
          });
        });
      },
    },
  ];
}

function debrief(step, ctx) {
  return [
    {
      type: htmlButton,
      stimulus: textPage(textToHtml(step.params.text)),
      choices: ["Finish"],
      on_finish: (data) => ctx.record(step, 0, { rt: Math.round(data.rt) }),
    },
  ];
}

// ---- Dot numerosity task -------------------------------------------------

const BOX = 250;
const GRID = 20;
const GAP = 60;

function drawDots(canvas, moreSide, diff, base, rng) {
  const c = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  c.fillStyle = "#000";
  c.fillRect(0, 0, w, h);
  const cell = BOX / GRID;
  const maxDots = GRID * GRID;
  const more = Math.min(maxDots, base + diff);
  const less = Math.min(maxDots, base);
  const x0 = (w - 2 * BOX - GAP) / 2;
  const y0 = (h - BOX) / 2;
  [
    ["left", x0],
    ["right", x0 + BOX + GAP],
  ].forEach(([side, bx]) => {
    c.strokeStyle = "#fff";
    c.lineWidth = 2;
    c.strokeRect(bx, y0, BOX, BOX);
    const n = side === moreSide ? more : less;
    const cells = rng.shuffle([...Array(maxDots).keys()]).slice(0, n);
    c.fillStyle = "#fff";
    for (const k of cells) {
      const cx = bx + (k % GRID) * cell + cell / 2;
      const cy = y0 + Math.floor(k / GRID) * cell + cell / 2;
      c.beginPath();
      c.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
      c.fill();
    }
  });
  c.fillStyle = "#fff";
  c.beginPath();
  c.arc(w / 2, h / 2, 3, 0, Math.PI * 2);
  c.fill();
}

function dots(step, ctx) {
  const p = step.params;
  const sc = p.staircase;
  let stair;
  if ("continue_from" in sc) stair = createStaircase({}, ctx.stairs[sc.continue_from]?.snapshot());
  else if ("fixed_diff" in sc) stair = createStaircase({ start_diff: sc.fixed_diff, step: [0] });
  else stair = createStaircase(sc);
  ctx.stairs[step.id] = stair;

  const scale = p.confidence ? p.confidence.scale : null;
  const keyName = (k) => k.toUpperCase();
  const reminder = `<p class="so-keys">${keyName(p.keys.left)} = left &nbsp;&nbsp; ${keyName(p.keys.right)} = right</p>`;
  const nodes = [];

  step.items.forEach((it, idx) => {
    if (p.break_between_blocks && idx > 0 && it.block !== step.items[idx - 1].block) {
      nodes.push({
        type: htmlButton,
        stimulus: textPage(`<p>End of block ${it.block} of ${p.blocks}. Take a short break.</p>`),
        choices: ["Continue"],
      });
    }
    const row = { trial: it.trial, block: it.block, side: it.side };
    nodes.push({
      type: htmlKeyboard,
      stimulus: `<div class="so-fix">+</div>`,
      choices: "NO_KEYS",
      trial_duration: p.fixation_ms,
    });
    nodes.push({
      type: canvasKeyboard,
      canvas_size: [320, 2 * BOX + GAP + 40],
      choices: [p.keys.left, p.keys.right],
      stimulus_duration: p.stim_ms,
      prompt: reminder,
      stimulus: (canvas) => {
        row.difficulty = stair.value;
        drawDots(canvas, it.side, row.difficulty, p.base_dots, makeRng(`${ctx.seed}:${step.id}:${it.trial}`));
        let first = null;
        const watch = (t) => {
          if (first === null) first = t;
          if (!canvas.isConnected) return; // answered before the stimulus ended
          if (canvas.style.visibility === "hidden") {
            row.stim_ms_actual = Math.round(t - first);
            ctx.timing.recordStimulus(p.stim_ms, t - first);
            return;
          }
          requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
      },
      on_finish: (data) => {
        row.response = data.response === p.keys.left ? "left" : "right";
        row.correct = row.response === it.side;
        row.rt = Math.round(data.rt);
        stair.update(row.correct);
        if (!scale) {
          row.confidence = null;
          row.confidence_rt = null;
          ctx.record(step, it.trial, row);
        }
      },
    });
    if (scale) {
      const levels = [];
      for (let v = scale[0]; v <= scale[1]; v++) levels.push(String(v));
      nodes.push({
        type: htmlButton,
        stimulus: `<p>How confident are you?</p>`,
        choices: levels,
        prompt: `<div class="so-scale"><span>${escapeHtml(p.confidence.labels[0])}</span><span>${escapeHtml(p.confidence.labels[1])}</span></div>`,
        button_layout: "flex",
        on_finish: (data) => {
          row.confidence = scale[0] + data.response;
          row.confidence_rt = Math.round(data.rt);
          ctx.record(step, it.trial, row);
        },
      });
    }
    if (p.feedback === "always") {
      nodes.push({
        type: htmlKeyboard,
        stimulus: () => (row.correct ? `<p class="so-fb so-ok">Correct</p>` : `<p class="so-fb so-no">Wrong</p>`),
        choices: "NO_KEYS",
        trial_duration: 700,
      });
    }
  });
  return nodes;
}

// ---- Choice reaction time (flanker, Stroop, Simon...) ---------------------

const POS = {
  center: "",
  left: "transform: translateX(-28vw);",
  right: "transform: translateX(28vw);",
  top: "transform: translateY(-22vh);",
  bottom: "transform: translateY(22vh);",
};

function choiceRt(step, ctx) {
  const p = step.params;
  const byId = Object.fromEntries(p.stimuli.map((s) => [s.id, s]));
  const keyToName = Object.fromEntries(p.responses.map((r) => [r.key.toLowerCase(), r.name]));
  const keys = p.responses.map((r) => r.key.toLowerCase());
  const reminder = p.show_key_reminder
    ? `<p class="so-keys">${p.responses.map((r) => escapeHtml(r.label ?? `${r.key.toUpperCase()} = ${r.name}`)).join(" &nbsp;&nbsp; ")}</p>`
    : "";
  const family = p.font === "mono" ? "ui-monospace, Menlo, Consolas, monospace" : "system-ui, sans-serif";
  const scale = p.confidence ? p.confidence.scale : null;
  const nodes = [];

  step.items.forEach((it, idx) => {
    if (p.break_between_blocks && idx > 0 && it.block !== step.items[idx - 1].block) {
      nodes.push({ type: htmlButton, stimulus: textPage(`<p>End of block ${it.block} of ${p.blocks}. Take a short break.</p>`), choices: ["Continue"] });
    }
    const st = byId[it.stimulus_id];
    const row = { trial: it.trial, block: it.block, stimulus_id: it.stimulus_id, type: it.type, correct_response: it.correct_response };
    if (p.fixation_ms > 0) nodes.push({ type: htmlKeyboard, stimulus: `<div class="so-fix">+</div>`, choices: "NO_KEYS", trial_duration: p.fixation_ms });
    const style = `font-size:${p.font_size}px;font-family:${family};${st.color ? `color:${st.color};` : ""}${POS[st.position] ?? ""}letter-spacing:0.05em;white-space:pre;`;
    nodes.push({
      type: htmlKeyboard,
      stimulus: `<div class="so-stim" style="${style}">${escapeHtml(st.text)}</div>`,
      choices: keys,
      stimulus_duration: p.stim_ms,
      trial_duration: p.response_window_ms,
      response_ends_trial: true,
      prompt: reminder,
      on_finish: (data) => {
        const k = data.response ? String(data.response).toLowerCase() : null;
        row.response = k ? keyToName[k] ?? null : null;
        row.timeout = !k;
        row.correct = row.response === it.correct_response;
        row.rt = k ? Math.round(data.rt) : null;
        if (!scale || row.timeout) {
          row.confidence = null;
          row.confidence_rt = null;
          ctx.record(step, it.trial, row);
        }
      },
    });
    if (scale) {
      const levels = [];
      for (let v = scale[0]; v <= scale[1]; v++) levels.push(String(v));
      nodes.push({
        timeline: [
          {
            type: htmlButton,
            stimulus: `<p>How confident are you?</p>`,
            choices: levels,
            prompt: `<div class="so-scale"><span>${escapeHtml(p.confidence.labels[0])}</span><span>${escapeHtml(p.confidence.labels[1])}</span></div>`,
            button_layout: "flex",
            on_finish: (data) => {
              row.confidence = scale[0] + data.response;
              row.confidence_rt = Math.round(data.rt);
              ctx.record(step, it.trial, row);
            },
          },
        ],
        conditional_function: () => !row.timeout,
      });
    }
    if (p.feedback !== "never") {
      nodes.push({
        timeline: [
          {
            type: htmlKeyboard,
            stimulus: () =>
              row.timeout ? `<p class="so-fb so-no">Too slow</p>` : row.correct ? `<p class="so-fb so-ok">Correct</p>` : `<p class="so-fb so-no">Wrong</p>`,
            choices: "NO_KEYS",
            trial_duration: 600,
          },
        ],
        conditional_function: () => p.feedback === "always" || !row.correct,
      });
    }
    if (p.iti_ms > 0) nodes.push({ type: htmlKeyboard, stimulus: "", choices: "NO_KEYS", trial_duration: p.iti_ms });
  });
  return nodes;
}

// ---- Custom code (sandboxed) ----------------------------------------------

const MAX_ROWS = 5000;

function cleanRow(row, columns) {
  const out = {};
  for (const col of Object.keys(columns)) {
    const v = row?.[col];
    if (v === undefined || v === null) out[col] = null;
    else if (typeof v === "number" || typeof v === "boolean") out[col] = Number.isFinite(v) || typeof v === "boolean" ? v : null;
    else out[col] = String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 2000);
  }
  return out;
}

function customCode(step, ctx) {
  const p = step.params;
  return [
    {
      type: htmlKeyboard,
      stimulus: `<div class="so-text"><p>Loading...</p></div>`,
      choices: "NO_KEYS",
      trial_duration: null,
      response_ends_trial: false,
      on_load: () => {
        const origin = location.origin;
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-scripts");
        frame.className = "so-sandbox";
        frame.setAttribute("title", "Task");
        const csp =
          `default-src 'none'; script-src ${origin} 'unsafe-inline' 'unsafe-eval'; style-src ${origin} 'unsafe-inline'; ` +
          `img-src ${origin} https: data: blob:; media-src ${origin} https: data: blob:; font-src ${origin} data:`;
        frame.srcdoc =
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
          `<link rel="stylesheet" href="${origin}${__CSS_URL__}"></head>` +
          `<body><div id="so-root"></div><script src="${origin}${__SANDBOX_URL__}"></script></body></html>`;
        let rows = 0;
        let ended = false;
        const finish = () => {
          if (ended) return;
          ended = true;
          window.removeEventListener("message", onMessage);
          frame.remove();
          ctx.finish();
        };
        const fail = (message) => {
          ctx.timing.meta.custom_errors = (ctx.timing.meta.custom_errors ?? 0) + 1;
          if (ended) return;
          window.removeEventListener("message", onMessage);
          frame.remove();
          const host = document.querySelector("#jspsych-html-keyboard-response-stimulus") ?? document.body;
          host.innerHTML =
            `<div class="so-text"><p>Something went wrong in this part of the study. Please continue.</p>` +
            (ctx.preview ? `<pre class="so-err">${escapeHtml(message)}</pre>` : "") +
            `<p><button class="jspsych-btn" id="so-continue">Continue</button></p></div>`;
          document.getElementById("so-continue").onclick = () => {
            ended = true;
            ctx.finish();
          };
        };
        const onMessage = (e) => {
          if (e.source !== frame.contentWindow || !e.data || typeof e.data.so !== "string") return;
          const m = e.data;
          if (m.so === "ready") {
            frame.contentWindow.postMessage({ so: "start", code: p.code, params: p.params, condition: ctx.levels, seed: `${ctx.seed}:${step.id}` }, "*");
            frame.focus();
          } else if (m.so === "row") {
            if (rows >= MAX_ROWS) return;
            ctx.record(step, rows++, cleanRow(m.row, p.columns));
          } else if (m.so === "done") finish();
          else if (m.so === "error") fail(String(m.message ?? "error").slice(0, 500));
        };
        window.addEventListener("message", onMessage);
        document.body.appendChild(frame);
      },
    },
  ];
}

/** A zero-length trial that sends queued data between steps. */
export function flushNode(flush) {
  return { type: htmlKeyboard, stimulus: "", choices: "NO_KEYS", trial_duration: 0, on_start: flush };
}

export const RENDERERS = {
  "consent@1": consent,
  "instructions@1": instructions,
  "attention-check@1": attention,
  "likert-scale@1": likert,
  "debrief@1": debrief,
  "dots-2afc-confidence@1": dots,
  "choice-rt@1": choiceRt,
  "custom-jspsych@1": customCode,
};

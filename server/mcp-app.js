// Builds the single-file HTML for the in-chat panel (MCP App) once, at startup. One panel serves
// show_dashboard and simulate; the tool result says which view to open.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const PANEL_URI = 'ui://second-order/panel.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const built = await build({
  entryPoints: [resolve(root, 'server/panel/panel.js')],
  bundle: true, write: false, minify: true, format: 'iife', target: ['es2020'], outdir: 'out', logLevel: 'silent',
});
const js = built.outputFiles.find((f) => f.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script');
const css = built.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';

export const panelHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
</head>
<body>
<div class="bar">
  <span class="brand">Second Order</span>
  <span class="title" id="title">Loading…</span>
  <select id="version" aria-label="Version" disabled></select>
  <button class="btn" id="full" type="button">Fullscreen</button>
  <button class="btn" id="open" type="button" disabled>Open in browser</button>
</div>
<nav class="tabs">
  <button type="button" data-tab="try" class="active">Try it</button>
  <button type="button" data-tab="study">Study</button>
  <button type="button" data-tab="sim" id="tab-sim" hidden>Simulation<span class="count"></span></button>
  <button type="button" data-tab="check" id="tab-check" hidden>Launch check</button>
  <button type="button" data-tab="quality" id="tab-quality" hidden>Quality</button>
</nav>
<section class="view active" id="view-try"><iframe id="frame" title="Experiment dashboard" allow="fullscreen; autoplay"></iframe></section>
<section class="view" id="view-study"></section>
<section class="view" id="view-sim"></section>
<section class="view" id="view-check"></section>
<section class="view" id="view-quality"></section>
<form class="feedback" id="feedback" hidden>
  <input placeholder="Tell Claude what to change…" aria-label="Feedback for Claude">
  <button class="btn primary" type="submit">Send</button>
  <span class="sent"></span>
</form>
<script>window.__RUN_ORIGIN__ = ${JSON.stringify(config.runOrigin)};</script>
<script>${js}</script>
</body>
</html>`;

export const panelMeta = {
  ui: {
    // The dashboard is framed from the run origin; stimulus thumbnails load from it too.
    csp: { frameDomains: [config.runOrigin], resourceDomains: [config.runOrigin], connectDomains: [] },
    prefersBorder: true,
  },
};

export const panelToolMeta = { ui: { resourceUri: PANEL_URI }, 'ui/resourceUri': PANEL_URI, 'openai/outputTemplate': PANEL_URI };

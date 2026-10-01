// Builds the single-file HTML for the show_dashboard MCP App once, at startup.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const DASHBOARD_APP_URI = 'ui://second-order/dashboard.html';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const script = (
  await build({
    entryPoints: [resolve(root, 'server/dashboard/app.js')],
    bundle: true, write: false, minify: true, format: 'iife', target: ['es2020'], logLevel: 'silent',
  })
).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

export const dashboardAppHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: #fff; color: #000; font: 13px/1.3 Inter, system-ui, -apple-system, sans-serif; }
  .bar { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px; border-bottom: 1px solid #e0e0e0; }
  .brand { font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; }
  #title { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: #5f6368; }
  button { padding: 6px 10px; border: 1px solid #000; background: #fff; font: 500 11px/1 inherit; letter-spacing: .06em; text-transform: uppercase; cursor: pointer; }
  button:disabled { opacity: .4; cursor: default; }
  iframe { display: block; width: 100%; height: 640px; border: 0; }
</style>
</head>
<body>
<div class="bar">
  <span class="brand">Second Order</span>
  <span id="title">Loading dashboard…</span>
  <button id="full" type="button">Fullscreen</button>
  <button id="open" type="button" disabled>Open in browser</button>
</div>
<iframe id="frame" title="Experiment dashboard" allow="fullscreen; autoplay"></iframe>
<script>window.__RUN_ORIGIN__ = ${JSON.stringify(config.runOrigin)};</script>
<script>${script}</script>
</body>
</html>`;

export const dashboardAppMeta = {
  ui: {
    csp: { frameDomains: [config.runOrigin], connectDomains: [], resourceDomains: [] },
    prefersBorder: true,
  },
};

// The in-chat panel (MCP App, protocol 2026-01-26) for show_dashboard: embeds the version's dashboard
// from the run origin, with buttons to open it in the browser or fullscreen, and saves its downloads
// through the host. A minimal hand-written bridge: the official SDK adds ~550 KB for these few messages.

const RUN_ORIGIN = window.__RUN_ORIGIN__;
const frame = document.getElementById('frame');
const title = document.getElementById('title');
const openButton = document.getElementById('open');
const fullButton = document.getElementById('full');
let dashboardUrl = null;

/* ---------- JSON-RPC over postMessage with the host ---------- */

let nextId = 1;
const pending = new Map();
const send = (message) => window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*');
const notify = (method, params = {}) => send({ method, params });
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

window.addEventListener('message', (event) => {
  // Downloads handed up from the embedded dashboard.
  if (event.origin === RUN_ORIGIN && event.data?.type === 'second-order:download') {
    const { filename, mimeType, text } = event.data;
    request('ui/download-file', { contents: [{ type: 'resource', resource: { uri: `file:///${filename}`, mimeType, text } }] }).catch(() => {});
    return;
  }
  if (event.source !== window.parent) return;
  const msg = event.data;
  if (!msg || msg.jsonrpc !== '2.0') return;

  if (msg.id != null && !msg.method) {
    const waiting = pending.get(msg.id);
    pending.delete(msg.id);
    if (waiting) msg.error ? waiting.reject(msg.error) : waiting.resolve(msg.result);
  } else if (msg.method === 'ui/notifications/tool-result') {
    showResult(msg.params?.structuredContent);
  } else if (msg.id != null) {
    // Host requests (teardown, ping): acknowledge.
    send({ id: msg.id, result: {} });
  }
});

function showResult(result) {
  if (!result?.dashboard_url) return;
  dashboardUrl = result.dashboard_url;
  title.textContent = `${result.title} · version ${result.version}`;
  frame.src = dashboardUrl;
  openButton.disabled = false;
}

openButton.addEventListener('click', () => dashboardUrl && request('ui/open-link', { url: dashboardUrl }).catch(() => {}));
fullButton.addEventListener('click', () => request('ui/request-display-mode', { mode: 'fullscreen' }).catch(() => {}));

(async () => {
  try {
    await request('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Second Order dashboard', version: '1.0.0' },
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
    });
    notify('ui/notifications/initialized');
    notify('ui/notifications/size-changed', { height: document.documentElement.scrollHeight });
  } catch {
    title.textContent = 'This chat app could not show the dashboard. Use the link instead.';
  }
})();
